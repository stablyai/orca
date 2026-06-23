// Package e2e holds the live end-to-end test for the tailnet transport.
//
// The design doc defines inbound "done" as a phone with the official Tailscale
// app reaching the desktop over the tailnet. A phone is just another tailnet
// node, so this test stands in a second userspace tsnet node for the phone: it
// joins two nodes to a real tailnet and proves node B reaches a loopback service
// exposed by node A through the same Listen+Splice path the sidecar uses for the
// desktop's WebSocket server. That exercises the actual tailnet data path
// (control, DERP/NAT traversal, MagicDNS-less dial) without any hardware.
//
// It is skipped unless TS_AUTHKEY is set (a reusable, ephemeral auth key), so it
// never runs in the normal suite but is one command away for CI or a maintainer:
//
//	TS_AUTHKEY=tskey-... go test ./e2e/ -run TestTailnetInboundEndToEnd -v
package e2e

import (
	"context"
	"net"
	"os"
	"testing"
	"time"

	"tailscale.com/tsnet"

	"github.com/stablyai/orca/native/ts-sidecar/internal/forward"
)

func TestTailnetInboundEndToEnd(t *testing.T) {
	authKey := os.Getenv("TS_AUTHKEY")
	if authKey == "" {
		t.Skip("set TS_AUTHKEY (reusable, ephemeral) to run the live tailnet end-to-end test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// A loopback service standing in for the desktop's WebSocket server: it
	// upper-cases nothing, just echoes, so the round trip proves bytes flow.
	echoLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echoLn.Close()
	go serveEcho(echoLn)
	localAddr := echoLn.Addr().String()

	// Node A: the "desktop" sidecar node.
	desktop := startNode(t, ctx, "orca-e2e-desktop", authKey)
	defer desktop.Close()

	// Inbound: Listen on the tailnet and reverse-proxy to the loopback echo
	// service — exactly what main.startInboundForward does for the WS port.
	const inboundPort = "6790"
	inboundLn, err := desktop.Listen("tcp", ":"+inboundPort)
	if err != nil {
		t.Fatalf("desktop tailnet listen: %v", err)
	}
	defer inboundLn.Close()
	go acceptAndForward(inboundLn, localAddr)

	// Node B: the "phone" client node.
	phone := startNode(t, ctx, "orca-e2e-phone", authKey)
	defer phone.Close()

	desktopIP4, _ := desktop.TailscaleIPs()
	if !desktopIP4.IsValid() {
		t.Fatal("desktop has no tailnet IP after coming up")
	}

	// The phone dials the desktop's tailnet address and must reach the echo
	// service through the inbound forward.
	conn, err := phone.Dial(ctx, "tcp", net.JoinHostPort(desktopIP4.String(), inboundPort))
	if err != nil {
		t.Fatalf("phone dial desktop over tailnet: %v", err)
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := conn.Write([]byte("ping-over-tailnet")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len("ping-over-tailnet"))
	if _, err := readFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != "ping-over-tailnet" {
		t.Fatalf("echo mismatch: got %q", buf)
	}
}

func startNode(t *testing.T, ctx context.Context, hostname, authKey string) *tsnet.Server {
	t.Helper()
	srv := &tsnet.Server{
		Dir:       t.TempDir(),
		Hostname:  hostname,
		AuthKey:   authKey,
		Ephemeral: true,
	}
	if _, err := srv.Up(ctx); err != nil {
		t.Fatalf("%s: tailnet up: %v", hostname, err)
	}
	return srv
}

func acceptAndForward(ln net.Listener, localAddr string) {
	for {
		tailnetConn, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			local, err := net.Dial("tcp", localAddr)
			if err != nil {
				_ = tailnetConn.Close()
				return
			}
			forward.Splice(tailnetConn, local)
		}()
	}
}

func serveEcho(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			buf := make([]byte, 4096)
			for {
				n, err := conn.Read(buf)
				if n > 0 {
					if _, werr := conn.Write(buf[:n]); werr != nil {
						return
					}
				}
				if err != nil {
					return
				}
			}
		}()
	}
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
