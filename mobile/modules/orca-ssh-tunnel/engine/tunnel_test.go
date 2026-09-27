package sshtunnel

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type testServer struct {
	listener    net.Listener
	fingerprint string
	authCalls   atomic.Int32
	mu          sync.Mutex
	connections []net.Conn
	destination chan string
	key         ssh.PublicKey
	// handleChannels serves one SSH connection's channel stream; tests swap it.
	handleChannels func(*ssh.ServerConn, <-chan ssh.NewChannel, <-chan *ssh.Request)
}

func newTestServer(t *testing.T) *testServer {
	t.Helper()
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(private)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &testServer{listener: listener, fingerprint: ssh.FingerprintSHA256(signer.PublicKey()), destination: make(chan string, 32)}
	s.handleChannels = s.echoForwardingChannels
	config := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			s.authCalls.Add(1)
			if string(password) != "test-password" {
				return nil, errors.New("denied")
			}
			return nil, nil
		},
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			s.authCalls.Add(1)
			if s.key == nil || !bytes.Equal(key.Marshal(), s.key.Marshal()) {
				return nil, errors.New("denied")
			}
			return nil, nil
		},
	}
	config.AddHostKey(signer)
	t.Cleanup(func() { listener.Close(); s.drop() })
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.connections = append(s.connections, raw)
			s.mu.Unlock()
			go func() {
				defer raw.Close()
				connection, channels, requests, err := ssh.NewServerConn(raw, config)
				if err != nil {
					return
				}
				defer connection.Close()
				go ssh.DiscardRequests(requests)
				s.handleChannels(connection, channels, requests)
			}()
		}
	}()
	return s
}

// Echo whatever is forwarded, but only to 127.0.0.1:6768 like the mock Orca server.
func (s *testServer) echoForwardingChannels(_ *ssh.ServerConn, channels <-chan ssh.NewChannel, requests <-chan *ssh.Request) {
	for incoming := range channels {
		if incoming.ChannelType() != "direct-tcpip" {
			incoming.Reject(ssh.UnknownChannelType, "forwarding only")
			continue
		}
		var target struct {
			Host       string
			Port       uint32
			Origin     string
			OriginPort uint32
		}
		if ssh.Unmarshal(incoming.ExtraData(), &target) != nil || target.Host != "127.0.0.1" || target.Port != 6768 {
			incoming.Reject(ssh.Prohibited, "invalid destination")
			continue
		}
		s.destination <- target.Host
		channel, requests, err := incoming.Accept()
		if err != nil {
			continue
		}
		go ssh.DiscardRequests(requests)
		go func() { defer channel.Close(); _, _ = io.Copy(channel, channel) }()
	}
}

func (s *testServer) drop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, connection := range s.connections {
		connection.Close()
	}
	s.connections = nil
}

func (s *testServer) config() configuration {
	return configuration{Host: "127.0.0.1", Port: s.listener.Addr().(*net.TCPAddr).Port, Username: "test",
		TargetHost: "127.0.0.1", TargetPort: 6768, HostKeyFingerprint: s.fingerprint, Password: "test-password"}
}

func encode(c configuration) string { raw, _ := json.Marshal(c); return string(raw) }

func openTunnel(t *testing.T, tunnel *Tunnel, raw string) (string, []openStage) {
	t.Helper()
	encoded, err := tunnel.Open(raw)
	if err != nil {
		t.Fatal(err)
	}
	var result openResult
	if json.Unmarshal([]byte(encoded), &result) != nil {
		t.Fatal(encoded)
	}
	if result.Error != "" {
		t.Fatalf("open failed: %s (stages: %v)", result.Error, result.Stages)
	}
	return result.Endpoint, result.Stages
}

// openFailure asserts the embedded error code and returns the stage log so
// tests can prove intermediate steps are reported even on failure.
func openFailure(t *testing.T, tunnel *Tunnel, raw string) (string, []openStage) {
	t.Helper()
	encoded, err := tunnel.Open(raw)
	if err != nil {
		t.Fatal(err)
	}
	var result openResult
	if json.Unmarshal([]byte(encoded), &result) != nil {
		t.Fatal(encoded)
	}
	if result.Error == "" {
		t.Fatal("expected an embedded open error")
	}
	return result.Error, result.Stages
}

func TestForwardBinaryAndConcurrentChannels(t *testing.T) {
	server := newTestServer(t)
	tunnel := NewTunnel()
	defer tunnel.Close()
	endpoint, stages := openTunnel(t, tunnel, encode(server.config()))
	if !strings.HasPrefix(endpoint, "ws://127.0.0.1:") {
		t.Fatal(endpoint)
	}
	if len(stages) == 0 || stages[len(stages)-1].Code != "listening" {
		t.Fatal("missing stage log", stages)
	}
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			socket, err := net.Dial("tcp", strings.TrimPrefix(endpoint, "ws://"))
			if err != nil {
				t.Error(err)
				return
			}
			defer socket.Close()
			socket.SetDeadline(time.Now().Add(5 * time.Second))
			payload := bytes.Repeat([]byte{0, 1, 127, 255}, 32768)
			go func() { _, _ = socket.Write(payload); _ = socket.(*net.TCPConn).CloseWrite() }()
			got, err := io.ReadAll(socket)
			if err != nil || !bytes.Equal(got, payload) {
				t.Errorf("forward did not preserve binary bytes: %d, %v", len(got), err)
			}
		}()
	}
	workers.Wait()
	if len(server.destination) != 4 {
		t.Fatal("unexpected channel count")
	}
	tunnel.Close()
	tunnel.Close()
	socket, err := net.DialTimeout("tcp", strings.TrimPrefix(endpoint, "ws://"), time.Second)
	if err == nil {
		socket.Close()
		t.Fatal("listener survived close")
	}
}

func TestProbeAndMismatchNeverAuthenticate(t *testing.T) {
	server := newTestServer(t)
	c := server.config()
	// The probe sends host and port alone — no socket target, no credentials.
	if _, err := NewTunnel().Probe(encode(configuration{Host: "127.0.0.1", Port: server.listener.Addr().(*net.TCPAddr).Port})); err != nil {
		t.Fatalf("bare probe failed: %v", err)
	}
	probe := NewTunnel()
	rawProbe, err := probe.Probe(encode(c))
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	var result probeResult
	if json.Unmarshal([]byte(rawProbe), &result) != nil || result.Fingerprint != server.fingerprint {
		t.Fatalf("probe: %q", rawProbe)
	}
	if server.authCalls.Load() != 0 {
		t.Fatal("probe sent credentials")
	}
	c.HostKeyFingerprint = "SHA256:wrong"
	tunnel := NewTunnel()
	failure, _ := openFailure(t, tunnel, encode(c))
	if failure != "SSH_HOST_KEY_MISMATCH" {
		t.Fatal(failure)
	}
	if server.authCalls.Load() != 0 {
		t.Fatal("mismatch sent credentials")
	}
}

func TestEncryptedPrivateKey(t *testing.T) {
	server := newTestServer(t)
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(private)
	server.key = signer.PublicKey()
	block, err := ssh.MarshalPrivateKeyWithPassphrase(private, "test", []byte("passphrase"))
	if err != nil {
		t.Fatal(err)
	}
	c := server.config()
	c.Password = ""
	c.PrivateKey = string(pem.EncodeToMemory(block))
	c.Passphrase = "passphrase"
	tunnel := NewTunnel()
	defer tunnel.Close()
	if _, err := tunnel.Open(encode(c)); err != nil {
		t.Fatal(err)
	}
	c.Passphrase = "wrong"
	if failure, _ := openFailure(t, NewTunnel(), encode(c)); failure != "SSH_KEY_INVALID" {
		t.Fatal(failure)
	}
}

func TestCloseCancelsHandshakeAndPreCancelledOpen(t *testing.T) {
	listener, _ := net.Listen("tcp4", "127.0.0.1:0")
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() { socket, _ := listener.Accept(); accepted <- socket }()
	tunnel := NewTunnel()
	c := configuration{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "test",
		TargetHost: "127.0.0.1", TargetPort: 6768, Password: "secret", HostKeyFingerprint: "pin"}
	done := make(chan string, 1)
	go func() { raw, _ := tunnel.Open(encode(c)); done <- raw }()
	socket := <-accepted
	defer socket.Close()
	tunnel.Close()
	select {
	case raw := <-done:
		var result openResult
		if json.Unmarshal([]byte(raw), &result) != nil || result.Error == "" {
			t.Fatal("cancelled open succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not interrupt handshake")
	}
	cancelled := NewTunnel()
	cancelled.Close()
	if failure, _ := openFailure(t, cancelled, encode(c)); failure == "" {
		t.Fatal("pre-cancelled open succeeded")
	}
}

func TestServerDisconnectRetiresListener(t *testing.T) {
	server := newTestServer(t)
	tunnel := NewTunnel()
	defer tunnel.Close()
	endpoint, _ := openTunnel(t, tunnel, encode(server.config()))
	server.drop()
	select {
	case <-tunnel.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("disconnect retained tunnel")
	}
	// Close synchronizes listener teardown with the background Wait callback.
	tunnel.Close()
	socket, err := net.DialTimeout("tcp", strings.TrimPrefix(endpoint, "ws://"), time.Second)
	if err == nil {
		socket.Close()
		t.Fatal("listener survived SSH disconnect")
	}
}

func TestInvalidConfigAndAuth(t *testing.T) {
	server := newTestServer(t)
	c := server.config()
	c.Password = "wrong"
	if failure, _ := openFailure(t, NewTunnel(), encode(c)); failure == "" || strings.Contains(failure, "wrong") {
		t.Fatal("auth accepted or secret exposed", failure)
	}
	c.TargetPort = 0
	if failure, _ := openFailure(t, NewTunnel(), encode(c)); failure == "" {
		t.Fatal("invalid port accepted")
	}
}

// dialWherever handles direct-tcpip by dialing whatever the request names —
// like a normal sshd with AllowTcpForwarding — so target hostnames resolve
// on the server side.
func (s *testServer) dialWhereverChannels(_ *ssh.ServerConn, channels <-chan ssh.NewChannel, requests <-chan *ssh.Request) {
	for incoming := range channels {
		if incoming.ChannelType() != "direct-tcpip" {
			incoming.Reject(ssh.UnknownChannelType, "forwarding only")
			continue
		}
		var target struct {
			Host       string
			Port       uint32
			Origin     string
			OriginPort uint32
		}
		if ssh.Unmarshal(incoming.ExtraData(), &target) != nil {
			incoming.Reject(ssh.Prohibited, "invalid destination")
			continue
		}
		remote, err := net.Dial("tcp", net.JoinHostPort(target.Host, strconv.Itoa(int(target.Port))))
		if err != nil {
			incoming.Reject(ssh.ConnectionFailed, "unreachable")
			continue
		}
		channel, requests, err := incoming.Accept()
		if err != nil {
			remote.Close()
			continue
		}
		go ssh.DiscardRequests(requests)
		go func() {
			defer channel.Close()
			defer remote.Close()
			done := make(chan struct{}, 2)
			copy := func(dst io.Writer, src io.Reader) {
				_, _ = io.Copy(dst, src)
				if writer, ok := dst.(interface{ CloseWrite() error }); ok {
					_ = writer.CloseWrite()
				}
				done <- struct{}{}
			}
			go copy(remote, channel)
			go copy(channel, remote)
			// Wait for both directions; closing after the first would cut the reply.
			<-done
			timer := time.NewTimer(30 * time.Second)
			defer timer.Stop()
			select {
			case <-done:
			case <-timer.C:
			}
		}()
	}
}

// The client only knows the name; the SSH server resolves it and reaches a
// raw TCP echo listener that the test process never dialed by name itself.
func TestTargetHostnameResolvesOnSshServer(t *testing.T) {
	echo, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			socket, err := echo.Accept()
			if err != nil {
				return
			}
			// Why: CopyBuffer forces the generic loop — TCPConn's splice-based
			// ReadFrom breaks when the source and destination are the same socket.
			go func() { _, _ = io.CopyBuffer(socket, socket, make([]byte, 32*1024)); socket.Close() }()
		}
	}()
	server := newTestServer(t)
	server.handleChannels = server.dialWhereverChannels
	tunnel := NewTunnel()
	defer tunnel.Close()
	c := server.config()
	c.TargetHost = "localhost"
	c.TargetPort = echo.Addr().(*net.TCPAddr).Port
	endpoint, _ := openTunnel(t, tunnel, encode(c))
	socket, err := net.Dial("tcp", strings.TrimPrefix(endpoint, "ws://"))
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	socket.SetDeadline(time.Now().Add(5 * time.Second))
	payload := []byte("resolved-on-server")
	go func() { _, _ = socket.Write(payload); _ = socket.(*net.TCPConn).CloseWrite() }()
	got, err := io.ReadAll(socket)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("server-resolved forward corrupted bytes: %d, %v", len(got), err)
	}
}

func TestProxyJumpForwardsThroughJumpHost(t *testing.T) {
	target := newTestServer(t)
	jump := newTestServer(t)
	jump.handleChannels = jump.dialWhereverChannels
	tunnel := NewTunnel()
	defer tunnel.Close()
	c := target.config()
	// The name resolves on the jump host, not on this test process.
	c.Host = "localhost"
	c.Jump = &jumpConfiguration{
		Host: "127.0.0.1", Port: jump.listener.Addr().(*net.TCPAddr).Port, Username: "test",
		HostKeyFingerprint: jump.fingerprint, Password: "test-password",
	}
	endpoint, stages := openTunnel(t, tunnel, encode(c))
	if !strings.HasPrefix(endpoint, "ws://127.0.0.1:") {
		t.Fatal(endpoint)
	}
	codes := map[string]bool{}
	for _, stage := range stages {
		codes[stage.Code] = true
	}
	if !codes["jumped"] || !codes["listening"] {
		t.Fatal("missing jump stage log", stages)
	}
	socket, err := net.Dial("tcp", strings.TrimPrefix(endpoint, "ws://"))
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	socket.SetDeadline(time.Now().Add(5 * time.Second))
	payload := bytes.Repeat([]byte{9, 8, 7}, 4096)
	go func() { _, _ = socket.Write(payload); _ = socket.(*net.TCPConn).CloseWrite() }()
	got, err := io.ReadAll(socket)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("jump forward corrupted bytes: %d, %v", len(got), err)
	}
	if jump.authCalls.Load() != 1 {
		t.Fatal("jump host did not authenticate exactly once")
	}
}

func TestProxyJumpProbeReturnsBothFingerprints(t *testing.T) {
	target := newTestServer(t)
	jump := newTestServer(t)
	jump.handleChannels = jump.dialWhereverChannels
	c := target.config()
	c.Jump = &jumpConfiguration{
		Host: "127.0.0.1", Port: jump.listener.Addr().(*net.TCPAddr).Port, Username: "test",
		HostKeyFingerprint: jump.fingerprint, Password: "test-password",
	}
	raw, err := NewTunnel().Probe(encode(c))
	if err != nil {
		t.Fatal(err)
	}
	var result probeResult
	if json.Unmarshal([]byte(raw), &result) != nil {
		t.Fatal(raw)
	}
	if result.Fingerprint != target.fingerprint || result.JumpFingerprint != jump.fingerprint {
		t.Fatal("probe returned wrong fingerprints", result)
	}
	if target.authCalls.Load() != 0 {
		t.Fatal("probe sent target credentials through the jump")
	}
}

func TestProxyJumpRejectsJumpKeyMismatchBeforeAuth(t *testing.T) {
	target := newTestServer(t)
	jump := newTestServer(t)
	jump.handleChannels = jump.dialWhereverChannels
	c := target.config()
	c.Jump = &jumpConfiguration{
		Host: "127.0.0.1", Port: jump.listener.Addr().(*net.TCPAddr).Port, Username: "test",
		HostKeyFingerprint: "SHA256:wrong", Password: "test-password",
	}
	failure, _ := openFailure(t, NewTunnel(), encode(c))
	if failure != "SSH_HOST_KEY_MISMATCH" {
		t.Fatal(failure)
	}
	if jump.authCalls.Load() != 0 {
		t.Fatal("jump mismatch sent credentials")
	}
}

func TestProxyJumpUnreachableTargetFailsDistinctly(t *testing.T) {
	jump := newTestServer(t)
	jump.handleChannels = jump.dialWhereverChannels
	c := configuration{Host: "internal-name.invalid", Port: 2222, Username: "test",
		TargetHost: "localhost", TargetPort: 6768,
		HostKeyFingerprint: `SHA256:` + strings.Repeat("A", 43), Password: "test-password"}
	c.Jump = &jumpConfiguration{
		Host: "127.0.0.1", Port: jump.listener.Addr().(*net.TCPAddr).Port, Username: "test",
		HostKeyFingerprint: jump.fingerprint, Password: "test-password",
	}
	failure, stages := openFailure(t, NewTunnel(), encode(c))
	if failure != "SSH_JUMP_DIAL_FAILED" {
		t.Fatal(failure)
	}
	// The failure log must show progress up to the failing stage.
	codes := map[string]bool{}
	for _, stage := range stages {
		codes[stage.Code] = true
	}
	if !codes["jump-dial"] || !codes["jump-authenticated"] || !codes["jump-resolve"] || !codes["failed"] {
		t.Fatal("failure stage log incomplete", stages)
	}
}
