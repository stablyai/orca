package ephemeralsshconn_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/ephemeralsshconn"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// genKeyPEM generates a fresh ed25519 keypair and returns its OpenSSH
// PEM-encoded private key (what a real Vault-resolved/recipe identityFile
// would look like once decoded) plus the corresponding public key, for a
// fake server's PublicKeyCallback to check connections against.
func genKeyPEM(t *testing.T) (pemStr string, pub ssh.PublicKey) {
	t.Helper()
	sshPub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating keypair: %v", err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatalf("marshaling private key: %v", err)
	}
	pubKey, err := ssh.NewPublicKey(sshPub)
	if err != nil {
		t.Fatalf("building public key: %v", err)
	}
	return string(pem.EncodeToMemory(block)), pubKey
}

// startFakePlainSSHServer starts a minimal real SSH server (no Vault cert
// involved, unlike sshconn/connector_test.go's fakeSSHServer) that accepts
// exactly one authorized public key for exactly one expected user, and (for
// a "session" channel) replies to a single "exec" request with a fixed
// marker string — enough to prove Connect actually reached and
// authenticated against THIS server. authorizedKeys may list more than one
// key (ssh-agent tests offer the agent's key; direct-PrivateKeyPEM tests
// offer the parsed signer's key) — either being accepted is fine.
func startFakePlainSSHServer(t *testing.T, expectUser, marker string, authorizedKeys ...ssh.PublicKey) net.Listener {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating host keypair: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromSigner(hostPriv)
	if err != nil {
		t.Fatalf("wrapping host signer: %v", err)
	}

	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if conn.User() != expectUser {
				return nil, fmt.Errorf("unexpected user %q", conn.User())
			}
			for _, k := range authorizedKeys {
				if string(k.Marshal()) == string(key.Marshal()) {
					return nil, nil
				}
			}
			return nil, fmt.Errorf("unauthorized key")
		},
	}
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
			go handlePlainConn(rawConn, cfg, marker)
		}
	}()
	return listener
}

func handlePlainConn(rawConn net.Conn, cfg *ssh.ServerConfig, marker string) {
	sshConn, chans, reqs, err := ssh.NewServerConn(rawConn, cfg)
	if err != nil {
		_ = rawConn.Close()
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
		go func() {
			defer func() { _ = channel.Close() }()
			for req := range requests {
				if req.Type == "exec" {
					_ = req.Reply(true, nil)
					_, _ = channel.Write([]byte(marker))
					_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
					return
				}
				_ = req.Reply(false, nil)
			}
		}()
	}
}

// startFakeJumpHost starts a real SSH server that authenticates like
// startFakePlainSSHServer, but instead of a session/exec handler, serves
// "direct-tcpip" channels by dialing the requested destination and piping
// bytes both ways — the standard SSH port-forwarding server role that
// (*ssh.Client).Dial (called "forwardOut" in the TS reference, see
// Connector.dialViaJumpHost's doc comment) drives from the client side.
func startFakeJumpHost(t *testing.T, expectUser string, authorizedKeys ...ssh.PublicKey) net.Listener {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating jump host keypair: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromSigner(hostPriv)
	if err != nil {
		t.Fatalf("wrapping jump host signer: %v", err)
	}
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if conn.User() != expectUser {
				return nil, fmt.Errorf("unexpected user %q", conn.User())
			}
			for _, k := range authorizedKeys {
				if string(k.Marshal()) == string(key.Marshal()) {
					return nil, nil
				}
			}
			return nil, fmt.Errorf("unauthorized key")
		},
	}
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
			go handleJumpConn(rawConn, cfg)
		}
	}()
	return listener
}

func handleJumpConn(rawConn net.Conn, cfg *ssh.ServerConfig) {
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

func listenerPort(t *testing.T, l net.Listener) int {
	t.Helper()
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

func TestEphemeralSshConnector_AuthenticatesWithPrivateKeyPEM(t *testing.T) {
	pemKey, pub := genKeyPEM(t)
	listener := startFakePlainSSHServer(t, "deploy", "hello-from-target", pub)

	connector := ephemeralsshconn.NewConnector(domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: listenerPort(t, listener), Username: "deploy",
		PrivateKeyPEM: pemKey,
	}, ephemeralsshconn.Config{DialTimeout: 5 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := connector.Connect(ctx, domain.SshTarget{})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() { _ = conn.Close() }()

	stdout, _, err := conn.RunCommand(ctx, "irrelevant")
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if stdout != "hello-from-target" {
		t.Errorf("stdout = %q, want the fake server's marker", stdout)
	}
}

func TestEphemeralSshConnector_AuthenticatesWithIdentityAgentSocket(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating agent keypair: %v", err)
	}
	keyring := agent.NewKeyring()
	if err := keyring.Add(agent.AddedKey{PrivateKey: priv}); err != nil {
		t.Fatalf("adding key to fake agent keyring: %v", err)
	}
	signer, err := ssh.NewSignerFromSigner(priv)
	if err != nil {
		t.Fatalf("wrapping signer: %v", err)
	}

	sockPath := t.TempDir() + "/agent.sock"
	agentListener, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listening on fake agent socket: %v", err)
	}
	t.Cleanup(func() { _ = agentListener.Close() })
	go func() {
		for {
			conn, err := agentListener.Accept()
			if err != nil {
				return
			}
			go func() { _ = agent.ServeAgent(keyring, conn) }()
		}
	}()

	listener := startFakePlainSSHServer(t, "deploy", "hello-from-target", signer.PublicKey())

	connector := ephemeralsshconn.NewConnector(domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: listenerPort(t, listener), Username: "deploy",
		IdentityAgentSocket: sockPath,
	}, ephemeralsshconn.Config{DialTimeout: 5 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := connector.Connect(ctx, domain.SshTarget{})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer func() { _ = conn.Close() }()

	stdout, _, err := conn.RunCommand(ctx, "irrelevant")
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if stdout != "hello-from-target" {
		t.Errorf("stdout = %q, want the fake server's marker", stdout)
	}
}

// TestEphemeralSshConnector_JumpHost_DoubleHopViaForwardOut proves Connect
// actually reaches the TARGET server (not the jump host) when JumpHost is
// set — the jump host here would reject an exec (it has no session
// handler at all, only direct-tcpip forwarding), so a passing RunCommand
// against the target's marker is only possible if the double-hop worked.
func TestEphemeralSshConnector_JumpHost_DoubleHopViaForwardOut(t *testing.T) {
	pemKey, pub := genKeyPEM(t)
	jumpListener := startFakeJumpHost(t, "deploy", pub)
	targetListener := startFakePlainSSHServer(t, "deploy", "hello-from-real-target", pub)

	connector := ephemeralsshconn.NewConnector(domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: listenerPort(t, targetListener), Username: "deploy",
		PrivateKeyPEM: pemKey,
		JumpHost:      fmt.Sprintf("deploy@127.0.0.1:%d", listenerPort(t, jumpListener)),
	}, ephemeralsshconn.Config{DialTimeout: 5 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := connector.Connect(ctx, domain.SshTarget{})
	if err != nil {
		t.Fatalf("Connect via jump host: %v", err)
	}
	defer func() { _ = conn.Close() }()

	stdout, _, err := conn.RunCommand(ctx, "irrelevant")
	if err != nil {
		t.Fatalf("RunCommand: %v", err)
	}
	if stdout != "hello-from-real-target" {
		t.Errorf("stdout = %q, want the TARGET server's marker (proves the double-hop reached it, not the jump host)", stdout)
	}
}

func TestEphemeralSshConnector_FailsWhenNoCredentialConfigured(t *testing.T) {
	connector := ephemeralsshconn.NewConnector(domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: 22, Username: "deploy",
	}, ephemeralsshconn.Config{DialTimeout: time.Second})

	_, err := connector.Connect(context.Background(), domain.SshTarget{})
	if err == nil {
		t.Fatal("expected Connect to fail when neither PrivateKeyPEM nor IdentityAgentSocket is set")
	}
}

// TestEphemeralSshConnector_CredentialNeverLoggedOrPersisted is
// TASK-BE-EVM-013's core security regression-guard: this package must never
// log or otherwise format PrivateKeyPEM/IdentityAgentSocket into a string,
// and must not import a logging package at all (there is no legitimate
// reason for this specific package to log anything — its only job is to
// dial and return a connection or an error, and every error already
// mentions only addr/host, never target wholesale).
func TestEphemeralSshConnector_CredentialNeverLoggedOrPersisted(t *testing.T) {
	src, err := os.ReadFile("connector.go")
	if err != nil {
		t.Fatalf("reading connector.go: %v", err)
	}
	text := string(src)

	if strings.Contains(text, `"log"`) || strings.Contains(text, `"log/slog"`) {
		t.Fatal("ephemeralsshconn/connector.go must not import a logging package — credential material must never reach a log statement")
	}

	for i, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue // doc comments may legitimately name the field
		}
		lower := strings.ToLower(line)
		mentionsFormatCall := strings.Contains(lower, "errorf(") || strings.Contains(lower, "sprintf(") ||
			strings.Contains(lower, "println(") || strings.Contains(lower, "print(")
		// Only flag an actual FIELD-VALUE read (".PrivateKeyPEM"/
		// ".IdentityAgentSocket", a Go struct-field access) inside a format
		// call — a bare mention of the field NAME in a static error string
		// (e.g. "...neither identityAgent nor identityFile/PrivateKeyPEM
		// set") names the field, not its value, and leaks nothing.
		if mentionsFormatCall && (strings.Contains(line, ".PrivateKeyPEM") || strings.Contains(line, ".IdentityAgentSocket")) {
			t.Errorf("connector.go:%d appears to format credential material's VALUE into a string: %s", i+1, line)
		}
		if strings.Contains(line, "%+v") && (strings.Contains(line, "c.target") || strings.Contains(line, "target)")) {
			t.Errorf("connector.go:%d formats the whole target struct with %%+v, which would include credential material: %s", i+1, line)
		}
	}
}
