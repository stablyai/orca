// Command ts-sidecar is the userspace tailnet sidecar the Orca desktop spawns.
// It joins the user's tailnet via tsnet (no kernel TUN, no routing changes) and
// exposes:
//   - a loopback SOCKS5 proxy for outbound dials to tailnet hosts, and
//   - an NDJSON control socket the desktop uses for status/auth/lifecycle.
//
// It deliberately performs no inbound tailnet Listen yet; that lands with the
// desktop inbound phase.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"tailscale.com/net/socks5"
	"tailscale.com/tsnet"

	"github.com/stablyai/orca/native/ts-sidecar/internal/forward"
	"github.com/stablyai/orca/native/ts-sidecar/internal/ipc"
	"github.com/stablyai/orca/native/ts-sidecar/internal/tailnet"
)

// readyPrefix is printed to stdout once the sidecar is listening, so the desktop
// launcher can wait for readiness (mirrors the relay's sentinel handshake).
const readyPrefix = "ORCA-TS-SIDECAR-READY "

// stateEventInterval is how often an open control connection is pushed a status
// event, so the desktop sees login/connect transitions without polling.
const stateEventInterval = 1500 * time.Millisecond

func main() {
	socketPath := flag.String("socket", "", "path to the NDJSON control unix socket (required)")
	tokenPath := flag.String("token", "", "path to the shared auth token file (required)")
	stateDir := flag.String("state-dir", "", "directory for persisted tailnet node state (required)")
	hostname := flag.String("hostname", "orca", "hostname to present to the tailnet")
	inboundPort := flag.Int("inbound-port", 0, "if non-zero, accept tailnet connections on this port and reverse-proxy them to 127.0.0.1:<port>")
	flag.Parse()

	if *socketPath == "" || *tokenPath == "" || *stateDir == "" {
		log.Fatal("ts-sidecar: --socket, --token and --state-dir are required")
	}

	token, err := os.ReadFile(*tokenPath)
	if err != nil {
		log.Fatalf("ts-sidecar: read token: %v", err)
	}

	srv := &tsnet.Server{
		Dir:      *stateDir,
		Hostname: *hostname,
		// AuthKey is intentionally unset: the default flow is interactive login,
		// surfaced to the desktop as an auth URL.
		UserLogf: log.Printf,
	}
	if err := srv.Start(); err != nil {
		log.Fatalf("ts-sidecar: tsnet start: %v", err)
	}
	defer srv.Close()

	socksPort, err := startSocksProxy(srv)
	if err != nil {
		log.Fatalf("ts-sidecar: socks proxy: %v", err)
	}

	node, err := tailnet.New(srv, socksPort)
	if err != nil {
		log.Fatalf("ts-sidecar: node: %v", err)
	}

	if *inboundPort != 0 {
		if err := startInboundForward(srv, *inboundPort); err != nil {
			log.Fatalf("ts-sidecar: inbound listener: %v", err)
		}
	}

	ln, err := listenControl(*socketPath)
	if err != nil {
		log.Fatalf("ts-sidecar: control socket: %v", err)
	}
	defer ln.Close()

	dispatcher := ipc.NewDispatcher(strings.TrimSpace(string(token)), node)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go acceptLoop(ctx, ln, dispatcher, node)

	// Signal readiness with the socks port so the launcher can wire ssh2 before
	// the first status round-trip.
	fmt.Printf("%s%d\n", readyPrefix, socksPort)

	<-ctx.Done()
}

// startSocksProxy binds a loopback SOCKS5 listener whose dials are routed through
// the tailnet, and returns the chosen port.
func startSocksProxy(srv *tsnet.Server) (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	proxy := &socks5.Server{Dialer: srv.Dial}
	go func() {
		if err := proxy.Serve(ln); err != nil {
			log.Printf("ts-sidecar: socks serve ended: %v", err)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

// startInboundForward accepts tailnet connections on port and reverse-proxies
// each to the loopback service on the same port (the desktop's WS server). The
// WS server keeps its own bind; this is an additional path, not a replacement.
func startInboundForward(srv *tsnet.Server, port int) error {
	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return err
	}
	localAddr := fmt.Sprintf("127.0.0.1:%d", port)
	go func() {
		for {
			tailnetConn, err := ln.Accept()
			if err != nil {
				return
			}
			go proxyToLocal(tailnetConn, localAddr)
		}
	}()
	return nil
}

func proxyToLocal(tailnetConn net.Conn, localAddr string) {
	local, err := net.Dial("tcp", localAddr)
	if err != nil {
		log.Printf("ts-sidecar: inbound dial %s: %v", localAddr, err)
		_ = tailnetConn.Close()
		return
	}
	forward.Splice(tailnetConn, local)
}

// listenControl removes any stale socket then binds the control listener with
// owner-only permissions. Windows named-pipe support is wired up in the
// packaging phase; until then the sidecar is posix-only.
func listenControl(path string) (net.Listener, error) {
	if runtime.GOOS == "windows" {
		return nil, fmt.Errorf("ts-sidecar: windows named-pipe control socket not yet implemented")
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return ln, nil
}

func acceptLoop(ctx context.Context, ln net.Listener, d *ipc.Dispatcher, node ipc.Node) {
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go handleConn(ctx, conn, d, node)
	}
}

func handleConn(ctx context.Context, conn net.Conn, d *ipc.Dispatcher, node ipc.Node) {
	defer conn.Close()

	// Push periodic state events so the desktop tracks login/connect transitions.
	stopEvents := make(chan struct{})
	defer close(stopEvents)
	go pushStateEvents(conn, node, stopEvents)

	_ = ipc.ReadRequests(conn, func(req ipc.Request) {
		resp := d.Handle(ctx, req)
		line, err := ipc.EncodeLine(resp)
		if err != nil {
			return
		}
		_, _ = conn.Write(line)
	}, func(err error) {
		log.Printf("ts-sidecar: control parse error: %v", err)
	})
}

func pushStateEvents(conn net.Conn, node ipc.Node, stop <-chan struct{}) {
	ticker := time.NewTicker(stateEventInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			line, err := ipc.EncodeLine(ipc.NewStateEvent(node.Status()))
			if err != nil {
				continue
			}
			if _, err := conn.Write(line); err != nil {
				return
			}
		}
	}
}
