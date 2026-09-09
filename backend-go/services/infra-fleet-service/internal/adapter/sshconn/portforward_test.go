package sshconn_test

// CR-EVM-008/TASK-BE-EVM-022: Connection.SetupPortForwards end-to-end —
// dials a real local TCP echo server through a real SSH connection's
// direct-tcpip channel, the same path production traffic takes.

import (
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/sshconn"
)

// startFakeForwardingSSHServer starts a real SSH server whose only role is
// serving "direct-tcpip" channels by dialing the requested destination and
// piping bytes both ways — the standard SSH port-forwarding server role
// (*ssh.Client).Dial drives from the client side. Mirrors
// ephemeralsshconn/connector_test.go's handleJumpConn (same primitive,
// tested from the other adapter package here since sshconn.Connection is
// where SetupPortForwards actually lives).
func startFakeForwardingSSHServer(t *testing.T) (addr string, clientConfig *ssh.ClientConfig) {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating host keypair: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromSigner(hostPriv)
	if err != nil {
		t.Fatalf("wrapping host signer: %v", err)
	}
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	cfg.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			rawConn, err := listener.Accept()
			if err != nil {
				return
			}
			go handleForwardingConn(rawConn, cfg)
		}
	}()

	return listener.Addr().String(), &ssh.ClientConfig{
		User:            "test",
		Auth:            []ssh.AuthMethod{ssh.Password("")},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // test-only fake server
		Timeout:         5 * time.Second,
	}
}

func handleForwardingConn(rawConn net.Conn, cfg *ssh.ServerConfig) {
	sshConn, chans, reqs, err := ssh.NewServerConn(rawConn, cfg)
	if err != nil {
		_ = rawConn.Close()
		return
	}
	defer func() { _ = sshConn.Close() }()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		if newChannel.ChannelType() != "direct-tcpip" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only direct-tcpip supported")
			continue
		}
		var payload struct {
			DestAddr   string
			DestPort   uint32
			OriginAddr string
			OriginPort uint32
		}
		_ = ssh.Unmarshal(newChannel.ExtraData(), &payload)
		channel, requests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go ssh.DiscardRequests(requests)

		destConn, err := net.Dial("tcp", net.JoinHostPort(payload.DestAddr, strconv.Itoa(int(payload.DestPort))))
		if err != nil {
			_ = channel.Close()
			continue
		}
		go func() { _, _ = io.Copy(destConn, channel); _ = destConn.Close() }()
		go func() { _, _ = io.Copy(channel, destConn); _ = channel.Close() }()
	}
}

// startEchoServer starts a plain TCP server that echoes back whatever it
// receives — the "remote service" a port forward tunnels traffic to.
func startEchoServer(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(conn, conn) }()
		}
	}()
	_, portStr, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatalf("splitting addr: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parsing port: %v", err)
	}
	return port
}

func freeLocalPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("finding free port: %v", err)
	}
	defer func() { _ = l.Close() }()
	_, portStr, err := net.SplitHostPort(l.Addr().String())
	if err != nil {
		t.Fatalf("splitting addr: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parsing port: %v", err)
	}
	return port
}

func TestConnection_SetupPortForwards_ProxiesTrafficToRemoteHost(t *testing.T) {
	addr, clientConfig := startFakeForwardingSSHServer(t)
	client, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		t.Fatalf("dialing fake server: %v", err)
	}
	conn := sshconn.WrapClient(client)
	t.Cleanup(func() { _ = conn.Close() })

	echoPort := startEchoServer(t)
	localPort := freeLocalPort(t)

	if err := conn.SetupPortForwards([]sshconn.PortForward{
		{LocalPort: localPort, RemoteHost: "127.0.0.1", RemotePort: echoPort},
	}); err != nil {
		t.Fatalf("SetupPortForwards: %v", err)
	}

	// Give the listener goroutine a moment to actually be accepting —
	// SetupPortForwards returns once net.Listen succeeds, before any Accept
	// loop has necessarily started spinning.
	var localConn net.Conn
	for i := 0; i < 50; i++ {
		localConn, err = net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", localPort), 100*time.Millisecond)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("dialing forwarded local port: %v", err)
	}
	defer func() { _ = localConn.Close() }()

	const msg = "hello through the tunnel"
	if _, err := localConn.Write([]byte(msg)); err != nil {
		t.Fatalf("writing to forwarded conn: %v", err)
	}
	_ = localConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(localConn, buf); err != nil {
		t.Fatalf("reading echo through forwarded conn: %v", err)
	}
	if string(buf) != msg {
		t.Fatalf("echo = %q, want %q", buf, msg)
	}
}

func TestConnection_Close_ClosesForwardListeners(t *testing.T) {
	addr, clientConfig := startFakeForwardingSSHServer(t)
	client, err := ssh.Dial("tcp", addr, clientConfig)
	if err != nil {
		t.Fatalf("dialing fake server: %v", err)
	}
	conn := sshconn.WrapClient(client)

	localPort := freeLocalPort(t)
	if err := conn.SetupPortForwards([]sshconn.PortForward{
		{LocalPort: localPort, RemoteHost: "127.0.0.1", RemotePort: startEchoServer(t)},
	}); err != nil {
		t.Fatalf("SetupPortForwards: %v", err)
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// The local listener must be gone — a new dial to the same port must
	// fail (nothing accepting there anymore).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", localPort), 100*time.Millisecond); err != nil {
			return // expected: forwarded port no longer accepting
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("forwarded local port %d still accepting connections after Close()", localPort)
}
