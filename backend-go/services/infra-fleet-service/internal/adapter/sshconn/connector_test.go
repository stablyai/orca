package sshconn_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/sshconn"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeCA stands in for Vault's SSH secrets engine CA — it never talks to a
// real Vault, but exercises the exact same signed-certificate wire shape
// (ssh.Certificate, marshaled/parsed via ssh.MarshalAuthorizedKey /
// ssh.ParseAuthorizedKey) that a real Vault ssh/sign/<role> response would
// produce, so Connector.Connect's cert handling is exercised for real, not
// stubbed.
type fakeCA struct {
	signer ssh.Signer
}

func newFakeCA(t *testing.T) *fakeCA {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating fake CA keypair: %v", err)
	}
	signer, err := ssh.NewSignerFromSigner(priv)
	if err != nil {
		t.Fatalf("wrapping fake CA signer: %v", err)
	}
	return &fakeCA{signer: signer}
}

// fakeIssuer implements sshconn.SSHCertIssuer by actually signing the
// caller's ephemeral public key with the fake CA — a real (if fake-rooted)
// certificate round trip, not a canned return value.
type fakeIssuer struct {
	ca        *fakeCA
	principal string
	failWith  error
}

func (f *fakeIssuer) SSHSignPublicKey(_ context.Context, _ string, publicKeyOpenSSH string) (string, error) {
	if f.failWith != nil {
		return "", f.failWith
	}
	pubKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(publicKeyOpenSSH))
	if err != nil {
		return "", fmt.Errorf("fakeIssuer: parsing public key to sign: %w", err)
	}
	cert := &ssh.Certificate{
		Key:             pubKey,
		Serial:          1,
		CertType:        ssh.UserCert,
		ValidPrincipals: []string{f.principal},
		ValidAfter:      0,
		ValidBefore:     ssh.CertTimeInfinity,
	}
	if err := cert.SignCert(rand.Reader, f.ca.signer); err != nil {
		return "", fmt.Errorf("fakeIssuer: signing certificate: %w", err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(cert))), nil
}

// fakeSSHServer is a minimal, real SSH server (golang.org/x/crypto/ssh's own
// server-side API, not a mock) — accepts connections, authenticates via
// ssh.CertChecker against a trusted CA public key, and on a "session"
// channel handles a single "exec" request by writing back a fixed string
// plus a zero exit status. In the spirit of
// devserveragent/client_test.go's fakeAgent: a real, minimal, working
// counterpart, not a mock.
type fakeSSHServer struct {
	listener net.Listener
}

func startFakeSSHServer(t *testing.T, trustedCAPub ssh.PublicKey, expectPrincipal string) *fakeSSHServer {
	t.Helper()

	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating fake host keypair: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromSigner(hostPriv)
	if err != nil {
		t.Fatalf("wrapping fake host signer: %v", err)
	}

	checker := &ssh.CertChecker{
		IsUserAuthority: func(auth ssh.PublicKey) bool {
			return string(auth.Marshal()) == string(trustedCAPub.Marshal())
		},
	}

	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if conn.User() != expectPrincipal {
				return nil, fmt.Errorf("unexpected user %q", conn.User())
			}
			return checker.Authenticate(conn, key)
		},
	}
	cfg.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	srv := &fakeSSHServer{listener: listener}
	t.Cleanup(func() { _ = listener.Close() })

	go srv.serve(cfg)
	return srv
}

// port returns the OS-assigned port the fake server is listening on, for
// tests to feed into sshconn.Config{Port: ...} — Connect otherwise defaults
// to the real port 22 (see connector.go's documented gap).
func (s *fakeSSHServer) port(t *testing.T) int {
	t.Helper()
	_, portStr, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		t.Fatalf("splitting fake server addr: %v", err)
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		t.Fatalf("parsing fake server port: %v", err)
	}
	return port
}

func (s *fakeSSHServer) serve(cfg *ssh.ServerConfig) {
	for {
		rawConn, err := s.listener.Accept()
		if err != nil {
			return // listener closed at test cleanup
		}
		go s.handleConn(rawConn, cfg)
	}
}

func (s *fakeSSHServer) handleConn(rawConn net.Conn, cfg *ssh.ServerConfig) {
	sshConn, chans, reqs, err := ssh.NewServerConn(rawConn, cfg)
	if err != nil {
		_ = rawConn.Close()
		return // auth failure or handshake failure — expected in the rejection test
	}
	defer func() { _ = sshConn.Close() }()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only session channels supported")
			continue
		}
		channel, requests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go handleSessionRequests(channel, requests)
	}
}

func handleSessionRequests(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer func() { _ = channel.Close() }()
	for req := range requests {
		switch req.Type {
		case "exec":
			var execMsg struct{ Command string }
			if err := ssh.Unmarshal(req.Payload, &execMsg); err != nil {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			_, _ = channel.Write([]byte("fake-server-output for: " + execMsg.Command))
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			return
		default:
			_ = req.Reply(false, nil)
		}
	}
}

func TestConnectAndRunCommand_SucceedsAgainstFakeServer(t *testing.T) {
	ca := newFakeCA(t)
	server := startFakeSSHServer(t, ca.signer.PublicKey(), "deploy")

	target, err := domain.NewSshTarget("target-1", "tenant-1", "127.0.0.1", "deploy", "role-1")
	if err != nil {
		t.Fatalf("NewSshTarget: %v", err)
	}

	issuer := &fakeIssuer{ca: ca, principal: "deploy"}
	connector := sshconn.NewConnector(issuer, sshconn.Config{DialTimeout: 5 * time.Second, Port: server.port(t)})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := connector.Connect(ctx, target)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() { _ = conn.Close() }()

	stdout, _, err := conn.RunCommand(ctx, "echo hi")
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if !strings.Contains(stdout, "echo hi") {
		t.Errorf("stdout = %q, want it to contain the executed command", stdout)
	}
}

func TestConnect_FailsWhenIssuerErrors(t *testing.T) {
	ca := newFakeCA(t)
	server := startFakeSSHServer(t, ca.signer.PublicKey(), "deploy")

	target, err := domain.NewSshTarget("target-2", "tenant-1", "127.0.0.1", "deploy", "role-1")
	if err != nil {
		t.Fatalf("NewSshTarget: %v", err)
	}

	issuer := &fakeIssuer{ca: ca, principal: "deploy", failWith: errors.New("vault: role not found")}
	connector := sshconn.NewConnector(issuer, sshconn.Config{DialTimeout: 5 * time.Second, Port: server.port(t)})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := connector.Connect(ctx, target)
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected Connect to fail when the issuer errors (Vault unreachable/role-not-found)")
	}
	if !strings.Contains(err.Error(), "role not found") {
		t.Errorf("expected the wrapped error to mention the underlying cause, got: %v", err)
	}
}

// TestWrapClient_BuildsAWorkingConnection is TASK-BE-EVM-013's regression
// test for sshconn.WrapClient — adapter/ephemeralsshconn dials with its own
// (non-Vault-cert) auth and hands the resulting *ssh.Client to WrapClient,
// which must produce a *Connection just as usable as one built by
// Connector.Connect itself (RunCommand/SFTPClient/NewSession all work).
func TestWrapClient_BuildsAWorkingConnection(t *testing.T) {
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating host keypair: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromSigner(hostPriv)
	if err != nil {
		t.Fatalf("wrapping host signer: %v", err)
	}
	_, clientPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating client keypair: %v", err)
	}
	clientSigner, err := ssh.NewSignerFromSigner(clientPriv)
	if err != nil {
		t.Fatalf("wrapping client signer: %v", err)
	}

	cfg := &ssh.ServerConfig{PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
		return nil, nil // accept any key — this test only exercises WrapClient, not auth policy
	}}
	cfg.AddHostKey(hostSigner)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		rawConn, err := listener.Accept()
		if err != nil {
			return
		}
		sshConn, chans, reqs, err := ssh.NewServerConn(rawConn, cfg)
		if err != nil {
			return
		}
		defer func() { _ = sshConn.Close() }()
		go ssh.DiscardRequests(reqs)
		for newChannel := range chans {
			if newChannel.ChannelType() != "session" {
				_ = newChannel.Reject(ssh.UnknownChannelType, "only session channels supported")
				continue
			}
			channel, requests, err := newChannel.Accept()
			if err != nil {
				continue
			}
			go handleSessionRequests(channel, requests)
		}
	}()

	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{
		User: "deploy", Auth: []ssh.AuthMethod{ssh.PublicKeys(clientSigner)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // test only
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatalf("dialing fake server directly: %v", err)
	}

	conn := sshconn.WrapClient(client)
	defer func() { _ = conn.Close() }()

	stdout, _, err := conn.RunCommand(context.Background(), "echo hi")
	if err != nil {
		t.Fatalf("RunCommand over a WrapClient-built Connection: %v", err)
	}
	if !strings.Contains(stdout, "echo hi") {
		t.Errorf("stdout = %q, want it to contain the executed command", stdout)
	}
}

func TestConnect_FailsWhenServerRejectsCert(t *testing.T) {
	realCA := newFakeCA(t)
	wrongCA := newFakeCA(t)
	server := startFakeSSHServer(t, realCA.signer.PublicKey(), "deploy") // server trusts realCA only

	target, err := domain.NewSshTarget("target-3", "tenant-1", "127.0.0.1", "deploy", "role-1")
	if err != nil {
		t.Fatalf("NewSshTarget: %v", err)
	}

	issuer := &fakeIssuer{ca: wrongCA, principal: "deploy"} // signs with the WRONG CA
	connector := sshconn.NewConnector(issuer, sshconn.Config{DialTimeout: 5 * time.Second, Port: server.port(t)})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := connector.Connect(ctx, target)
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected Connect to fail when the fake server rejects a cert signed by an untrusted CA")
	}
}
