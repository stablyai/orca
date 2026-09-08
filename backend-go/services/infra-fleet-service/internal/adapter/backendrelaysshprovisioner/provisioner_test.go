package backendrelaysshprovisioner_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/backendrelaysshprovisioner"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/devserveragent"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/ephemeralsshconn"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/sshrelay"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// The fake SSH server below mirrors adapter/sshrelay/provisioner_test.go's
// fakeSSHServer almost exactly (deploy(SFTP)+launch(exec --stdio, real
// handshake)+checksum verification, all genuinely exercised, not mocked) —
// duplicated rather than shared (that package's fake is unexported), with
// ONE difference: plain public-key auth (PublicKeyCallback against one
// known key) instead of Vault-cert auth, matching what
// adapter/ephemeralsshconn.Connector actually dials with.

type fakeSSHServer struct {
	listener    net.Listener
	deployDir   string
	badChecksum bool
	// hostPub is the server's own host public key (TASK-BE-EVM-019
	// addition) — TOFU tests need it to compute the SAME SHA256
	// fingerprint ssh.FingerprintSHA256 derives client-side.
	hostPub ssh.PublicKey
}

// hostKeyFingerprint returns this server's real host key's SHA256
// fingerprint, in the exact format ephemeralsshconn.Connector.ObservedFingerprint
// returns — TASK-BE-EVM-019's TOFU tests compare against this.
func (s *fakeSSHServer) hostKeyFingerprint() string {
	return ssh.FingerprintSHA256(s.hostPub)
}

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

func startFakeSSHServer(t *testing.T, expectUser string, authorizedKey ssh.PublicKey, badChecksum bool) *fakeSSHServer {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating host keypair: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromSigner(hostPriv)
	if err != nil {
		t.Fatalf("wrapping host signer: %v", err)
	}
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if conn.User() != expectUser {
			return nil, fmt.Errorf("unexpected user %q", conn.User())
		}
		if string(key.Marshal()) != string(authorizedKey.Marshal()) {
			return nil, fmt.Errorf("unauthorized key")
		}
		return nil, nil
	}}
	cfg.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	hostPub, err := ssh.NewPublicKey(hostPriv.Public())
	if err != nil {
		t.Fatalf("building host public key: %v", err)
	}
	srv := &fakeSSHServer{listener: listener, deployDir: t.TempDir(), badChecksum: badChecksum, hostPub: hostPub}
	t.Cleanup(func() { _ = listener.Close() })
	go srv.serve(t, cfg)
	return srv
}

func (s *fakeSSHServer) port(t *testing.T) int {
	t.Helper()
	_, portStr, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		t.Fatalf("splitting addr: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parsing port: %v", err)
	}
	return port
}

func (s *fakeSSHServer) serve(t *testing.T, cfg *ssh.ServerConfig) {
	for {
		rawConn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handleConn(t, rawConn, cfg)
	}
}

func (s *fakeSSHServer) handleConn(t *testing.T, rawConn net.Conn, cfg *ssh.ServerConfig) {
	sshConn, chans, reqs, err := ssh.NewServerConn(rawConn, cfg)
	if err != nil {
		_ = rawConn.Close()
		return
	}
	defer func() { _ = sshConn.Close() }()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		switch newChannel.ChannelType() {
		case "session":
			channel, requests, err := newChannel.Accept()
			if err != nil {
				continue
			}
			go s.handleSessionRequests(t, channel, requests)
		default:
			_ = newChannel.Reject(ssh.UnknownChannelType, "only session channels supported")
		}
	}
}

func (s *fakeSSHServer) handleSessionRequests(t *testing.T, channel ssh.Channel, requests <-chan *ssh.Request) {
	defer func() { _ = channel.Close() }()
	for req := range requests {
		switch req.Type {
		case "exec":
			var execMsg struct{ Command string }
			_ = ssh.Unmarshal(req.Payload, &execMsg)
			_ = req.Reply(true, nil)
			s.handleExec(t, channel, execMsg.Command)
			return
		case "subsystem":
			var subMsg struct{ Name string }
			_ = ssh.Unmarshal(req.Payload, &subMsg)
			if subMsg.Name != "sftp" {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			s.handleSFTP(t, channel)
			return
		default:
			_ = req.Reply(false, nil)
		}
	}
}

func exitStatus(channel ssh.Channel, code uint32) {
	_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
}

func (s *fakeSSHServer) handleExec(t *testing.T, channel ssh.Channel, cmd string) {
	switch {
	case strings.HasPrefix(cmd, "mkdir -p"):
		dir := strings.Trim(strings.TrimSpace(strings.TrimPrefix(cmd, "mkdir -p")), "'\"")
		if err := os.MkdirAll(filepath.Join(s.deployDir, dir), 0o755); err != nil {
			exitStatus(channel, 1)
			return
		}
		exitStatus(channel, 0)
	case strings.Contains(cmd, "createHash('sha256')"):
		const marker = "readFileSync('"
		start := strings.Index(cmd, marker)
		if start < 0 {
			exitStatus(channel, 1)
			return
		}
		start += len(marker)
		end := strings.Index(cmd[start:], "'")
		if end < 0 {
			exitStatus(channel, 1)
			return
		}
		remotePath := cmd[start : start+end]
		data, err := os.ReadFile(filepath.Join(s.deployDir, remotePath))
		if err != nil {
			exitStatus(channel, 1)
			return
		}
		sum := sha256.Sum256(data)
		hexSum := hex.EncodeToString(sum[:])
		if s.badChecksum {
			hexSum = "0000000000000000000000000000000000000000000000000000000000000000"
		}
		_, _ = channel.Write([]byte(hexSum))
		exitStatus(channel, 0)
	case strings.Contains(cmd, "--stdio"):
		s.runFakeAgentHandshake(t, channel)
	default:
		exitStatus(channel, 0)
	}
}

func (s *fakeSSHServer) runFakeAgentHandshake(t *testing.T, channel ssh.Channel) {
	params, _ := json.Marshal(map[string]any{"devServerId": "ds-1", "platform": "linux", "arch": "x64", "agentVersion": "2.1.0"})
	req := devserveragent.JSONRPCRequest{JSONRPC: "2.0", ID: 1, Method: "agent.handshake", Params: params}
	frame, err := devserveragent.EncodeJSONRPCFrame(req, 1, 0)
	if err != nil {
		t.Errorf("fake agent: encoding handshake request: %v", err)
		return
	}
	if _, err := channel.Write(frame); err != nil {
		return
	}
	buf := make([]byte, 4096)
	n, err := channel.Read(buf)
	if err != nil {
		return
	}
	decoded, err := devserveragent.DecodeFrame(buf[:n])
	if err != nil {
		t.Errorf("fake agent: decoding handshake response frame: %v", err)
		return
	}
	var resp devserveragent.JSONRPCResponse
	if err := json.Unmarshal(decoded.Payload, &resp); err != nil {
		t.Errorf("fake agent: unmarshaling handshake response: %v", err)
		return
	}
	if resp.Error != nil {
		t.Errorf("fake agent: handshake rejected: %+v", resp.Error)
	}
}

func (s *fakeSSHServer) handleSFTP(t *testing.T, channel ssh.Channel) {
	server, err := sftp.NewServer(channel, sftp.WithServerWorkingDirectory(s.deployDir))
	if err != nil {
		t.Errorf("starting fake sftp server: %v", err)
		return
	}
	_ = server.Serve()
}

func writeLocalBundle(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.js")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing local fake bundle: %v", err)
	}
	return path
}

// --- In-memory fakes for usecase.DevServerRepository/ConnectionRepository/
// EphemeralVmRuntimeRepository — full interfaces implemented (unused
// methods no-op), matching this codebase's established fake-per-test-file
// convention (see internal/usecase/*_test.go).

type fakeDevServers struct {
	registered []domain.DevServer
	err        error
}

func (f *fakeDevServers) Register(_ context.Context, ds domain.DevServer) (domain.DevServer, error) {
	if f.err != nil {
		return domain.DevServer{}, f.err
	}
	f.registered = append(f.registered, ds)
	return ds, nil
}
func (f *fakeDevServers) Get(context.Context, string, string) (domain.DevServer, error) {
	return domain.DevServer{}, fmt.Errorf("not implemented")
}
func (f *fakeDevServers) List(context.Context, string) ([]domain.DevServer, error) { return nil, nil }
func (f *fakeDevServers) FindBySshTarget(context.Context, string, string) (domain.DevServer, bool, error) {
	return domain.DevServer{}, false, nil
}
func (f *fakeDevServers) FindByHostAndMode(context.Context, string, string, domain.ConnectionMode) (domain.DevServer, bool, error) {
	return domain.DevServer{}, false, nil
}
func (f *fakeDevServers) UpdateApprovalStatus(context.Context, string, string, domain.DevServerStatus) (domain.DevServer, error) {
	return domain.DevServer{}, nil
}
func (f *fakeDevServers) AssignGroup(context.Context, string, string, string) (domain.DevServer, error) {
	return domain.DevServer{}, nil
}

type fakeConnections struct {
	created []domain.Connection
	err     error
	nextID  string
}

func (f *fakeConnections) CreateConnection(_ context.Context, conn domain.Connection) (domain.Connection, error) {
	if f.err != nil {
		return domain.Connection{}, f.err
	}
	if f.nextID != "" {
		conn.ID = f.nextID
	}
	f.created = append(f.created, conn)
	return conn, nil
}
func (f *fakeConnections) GetActiveByDevServer(context.Context, string, string) (domain.Connection, bool, error) {
	return domain.Connection{}, false, nil
}
func (f *fakeConnections) UpdateStatus(context.Context, string, domain.Connection) error { return nil }

type fakeRuntimes struct {
	setEnvironmentIDCalls []struct{ tenantID, runtimeID, environmentID string }
	setEnvironmentIDErr   error
}

func (f *fakeRuntimes) List(context.Context, string) ([]domain.EphemeralVmRuntime, error) {
	return nil, nil
}
func (f *fakeRuntimes) Get(context.Context, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeRuntimes) GetByWorkspaceID(context.Context, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeRuntimes) UpdateStatus(context.Context, string, string, string, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeRuntimes) UpdateProvisionResult(context.Context, string, string, string, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeRuntimes) FindDevServerByEnvironmentID(context.Context, string, string) (string, bool, error) {
	return "", false, nil
}
func (f *fakeRuntimes) SetEnvironmentID(_ context.Context, tenantID, runtimeID, environmentID string) (domain.EphemeralVmRuntime, error) {
	f.setEnvironmentIDCalls = append(f.setEnvironmentIDCalls, struct{ tenantID, runtimeID, environmentID string }{tenantID, runtimeID, environmentID})
	if f.setEnvironmentIDErr != nil {
		return domain.EphemeralVmRuntime{}, f.setEnvironmentIDErr
	}
	return domain.EphemeralVmRuntime{ID: runtimeID, EnvironmentID: environmentID}, nil
}

// fakeSshTargets is an in-memory usecase.EphemeralVmSshTargetRepository —
// TASK-BE-EVM-019's TOFU tests inspect upserted to confirm the observed
// host key fingerprint gets persisted, and seed byRuntime to simulate a
// PREVIOUSLY-recorded baseline for a "second dial" scenario.
type fakeSshTargets struct {
	byRuntime map[string]domain.EphemeralVmSshTargetRecord
	upserted  []domain.EphemeralVmSshTargetRecord
}

func (f *fakeSshTargets) Upsert(_ context.Context, record domain.EphemeralVmSshTargetRecord) (domain.EphemeralVmSshTargetRecord, error) {
	f.upserted = append(f.upserted, record)
	if f.byRuntime == nil {
		f.byRuntime = map[string]domain.EphemeralVmSshTargetRecord{}
	}
	f.byRuntime[record.RuntimeID] = record
	return record, nil
}

func (f *fakeSshTargets) Get(_ context.Context, tenantID, runtimeID string) (domain.EphemeralVmSshTargetRecord, bool, error) {
	rec, ok := f.byRuntime[runtimeID]
	if !ok || rec.TenantID != tenantID {
		return domain.EphemeralVmSshTargetRecord{}, false, nil
	}
	return rec, true, nil
}

func sequentialIDs(prefix string) func() string {
	n := 0
	return func() string {
		n++
		return fmt.Sprintf("%s-%d", prefix, n)
	}
}

func TestBackendRelaySshProvisioner_DialsDeploysLaunchesAndRegistersDevServer(t *testing.T) {
	pemKey, pub := genKeyPEM(t)
	server := startFakeSSHServer(t, "deploy", pub, false)
	bundlePath := writeLocalBundle(t, "// fake agent bundle\n")

	devServers := &fakeDevServers{}
	conns := &fakeConnections{nextID: "conn-ssh-1"}
	runtimes := &fakeRuntimes{}
	agentClient := devserveragent.New(devserveragent.DefaultConfig(), slog.Default())
	t.Cleanup(agentClient.Close)

	provisioner := backendrelaysshprovisioner.NewProvisioner(
		devServers, conns, runtimes, agentClient,
		sshrelay.Config{BundlePath: bundlePath, HandshakeTimeout: 5 * time.Second, OrcaVersion: "test"},
		ephemeralsshconn.Config{DialTimeout: 5 * time.Second},
		sequentialIDs("id"), nil,
	)

	target := domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: server.port(t), Username: "deploy", PrivateKeyPEM: pemKey,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connectionID, err := provisioner.Provision(ctx, "tenant-1", "rt-1", domain.DevServer{ID: "source-ds-1"}, target)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if connectionID != "conn-ssh-1" {
		t.Errorf("connectionID = %q, want conn-ssh-1", connectionID)
	}

	if len(devServers.registered) != 1 {
		t.Fatalf("expected exactly one dev server registered, got %+v", devServers.registered)
	}
	ds := devServers.registered[0]
	if ds.TenantID != "tenant-1" || ds.Host != "127.0.0.1" || ds.Mode != domain.ConnectionModeRelaySSH {
		t.Errorf("unexpected registered dev server: %+v", ds)
	}
	if ds.SSHTargetID == "" {
		t.Error("expected a non-empty placeholder SSHTargetID (domain.NewDevServer's relay-ssh invariant)")
	}

	if len(conns.created) != 1 {
		t.Fatalf("expected exactly one connection created, got %+v", conns.created)
	}
	if conns.created[0].DevServerID != ds.ID {
		t.Errorf("connection.DevServerID = %q, want %q", conns.created[0].DevServerID, ds.ID)
	}
	if conns.created[0].Status != domain.ConnectionStatusEstablished {
		t.Errorf("connection.Status = %q, want established", conns.created[0].Status)
	}

	if !agentClient.IsConnected(ds.ID) {
		t.Error("expected the provisioned dev server's session to be attached to agentClient (AttachTransport)")
	}
}

// TestBackendRelaySshProvisioner_SetsEnvironmentIdImmediately is
// TASK-BE-EVM-013's required test: unlike TASK-BE-EVM-006/011's orca-server
// correlation (async, event/token-endpoint-driven), Hướng B knows the
// runtimeID from the start and sets environment_id synchronously, within
// the same Provision call — no polling hook needed.
func TestBackendRelaySshProvisioner_SetsEnvironmentIdImmediately(t *testing.T) {
	pemKey, pub := genKeyPEM(t)
	server := startFakeSSHServer(t, "deploy", pub, false)
	bundlePath := writeLocalBundle(t, "// fake agent bundle\n")

	devServers := &fakeDevServers{}
	conns := &fakeConnections{}
	runtimes := &fakeRuntimes{}
	agentClient := devserveragent.New(devserveragent.DefaultConfig(), slog.Default())
	t.Cleanup(agentClient.Close)

	provisioner := backendrelaysshprovisioner.NewProvisioner(
		devServers, conns, runtimes, agentClient,
		sshrelay.Config{BundlePath: bundlePath, HandshakeTimeout: 5 * time.Second, OrcaVersion: "test"},
		ephemeralsshconn.Config{DialTimeout: 5 * time.Second},
		sequentialIDs("id"), nil,
	)

	target := domain.EphemeralVmSshTarget{Host: "127.0.0.1", Port: server.port(t), Username: "deploy", PrivateKeyPEM: pemKey}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := provisioner.Provision(ctx, "tenant-1", "rt-1", domain.DevServer{ID: "source-ds-1"}, target); err != nil {
		t.Fatalf("Provision: %v", err)
	}

	if len(runtimes.setEnvironmentIDCalls) != 1 {
		t.Fatalf("expected exactly one SetEnvironmentID call within Provision itself, got %+v", runtimes.setEnvironmentIDCalls)
	}
	call := runtimes.setEnvironmentIDCalls[0]
	if call.tenantID != "tenant-1" || call.runtimeID != "rt-1" {
		t.Errorf("unexpected SetEnvironmentID args: %+v", call)
	}
	if call.environmentID == "" {
		t.Error("expected environmentID to be the new dev server's real id, got empty")
	}
	if len(devServers.registered) != 1 || call.environmentID != devServers.registered[0].ID {
		t.Errorf("expected environmentID (%q) to equal the registered dev server's ID (%+v)", call.environmentID, devServers.registered)
	}
}

func TestBackendRelaySshProvisioner_FailsFastWhenHostEmpty(t *testing.T) {
	devServers := &fakeDevServers{}
	conns := &fakeConnections{}
	runtimes := &fakeRuntimes{}
	agentClient := devserveragent.New(devserveragent.DefaultConfig(), slog.Default())
	t.Cleanup(agentClient.Close)

	provisioner := backendrelaysshprovisioner.NewProvisioner(
		devServers, conns, runtimes, agentClient,
		sshrelay.Config{}, ephemeralsshconn.Config{}, sequentialIDs("id"), nil,
	)

	_, err := provisioner.Provision(context.Background(), "tenant-1", "rt-1", domain.DevServer{}, domain.EphemeralVmSshTarget{})
	if err == nil {
		t.Fatal("expected Provision to fail fast when target.Host is empty")
	}
	if len(devServers.registered) != 0 {
		t.Error("expected no dev server registration attempt when the target is invalid")
	}
}

// ─── TASK-BE-EVM-017: vm.readCredentialFile round-trip (Hướng B, Gap 1) ────

// fakeCredentialTransport is a minimal, real devserveragent.Transport (two
// buffered channels standing in for the wire) — used to attach a live
// session for sourceDevServer so agentClient.ReadCredentialFile has
// something to round-trip against. Mirrors devserveragent's own internal
// pipeTransport test helper (unexported, so duplicated here) built entirely
// from devserveragent's exported surface (DecodeFrame/EncodeJSONRPCFrame/
// JSONRPCRequest/JSONRPCResponse) — no access to that package's internals.
type fakeCredentialTransport struct {
	writes chan []byte
	reads  chan devserveragent.DecodedFrame
	closed chan struct{}
}

func newFakeCredentialTransport() *fakeCredentialTransport {
	return &fakeCredentialTransport{
		writes: make(chan []byte, 8),
		reads:  make(chan devserveragent.DecodedFrame, 8),
		closed: make(chan struct{}),
	}
}

func (t *fakeCredentialTransport) ReadFrame(ctx context.Context) (devserveragent.DecodedFrame, error) {
	select {
	case f := <-t.reads:
		return f, nil
	case <-t.closed:
		return devserveragent.DecodedFrame{}, fmt.Errorf("fakeCredentialTransport: closed")
	case <-ctx.Done():
		return devserveragent.DecodedFrame{}, ctx.Err()
	}
}

func (t *fakeCredentialTransport) WriteFrame(_ context.Context, frame []byte) error {
	select {
	case t.writes <- frame:
		return nil
	case <-t.closed:
		return fmt.Errorf("fakeCredentialTransport: closed")
	}
}

func (t *fakeCredentialTransport) Close(_ string) error {
	select {
	case <-t.closed:
	default:
		close(t.closed)
	}
	return nil
}

// respondToReadCredentialFile reads exactly one outgoing JSON-RPC request,
// records its method + "path" param into the returned struct, and answers
// with {"contentPEM": contentPEM}. Runs on its own goroutine in every
// caller (session.call blocks synchronously waiting for the response), so
// it reports failures via tb.Errorf, not the Fatal family — matching
// devserveragent's own pipeTransport.respondToNextCall precedent.
type observedRPCCall struct {
	method string
	path   string
}

func (t *fakeCredentialTransport) respondToReadCredentialFile(tb testing.TB, contentPEM string, observed *observedRPCCall) {
	tb.Helper()
	frame := <-t.writes
	decoded, err := devserveragent.DecodeFrame(frame)
	if err != nil {
		tb.Errorf("decoding frame written by session.call: %v", err)
		return
	}
	var req devserveragent.JSONRPCRequest
	if err := json.Unmarshal(decoded.Payload, &req); err != nil {
		tb.Errorf("unmarshaling request: %v", err)
		return
	}
	observed.method = req.Method
	var params map[string]any
	if err := json.Unmarshal(req.Params, &params); err == nil {
		if p, ok := params["path"].(string); ok {
			observed.path = p
		}
	}
	resultJSON, err := json.Marshal(map[string]any{"contentPEM": contentPEM})
	if err != nil {
		tb.Errorf("marshaling fake result: %v", err)
		return
	}
	resp := devserveragent.JSONRPCResponse{JSONRPC: "2.0", ID: req.ID, Result: resultJSON}
	respFrame, err := devserveragent.EncodeJSONRPCFrame(resp, decoded.ID, decoded.ID)
	if err != nil {
		tb.Errorf("encoding fake response: %v", err)
		return
	}
	respDecoded, err := devserveragent.DecodeFrame(respFrame)
	if err != nil {
		tb.Errorf("decoding fake response frame: %v", err)
		return
	}
	t.reads <- respDecoded
}

// TestBackendRelaySshProvisioner_ReadsCredentialFileFromSourceDevServer is
// TASK-BE-EVM-017's core Gap 1 test: when target.IdentityFilePath is set,
// Provision calls ReadCredentialFile against sourceDevServer BEFORE dialing
// (with the exact path), and dials using the bytes that call returns — the
// fake SSH server below only accepts the key ReadCredentialFile answers
// with, so a successful Provision proves the returned bytes were actually
// used for auth, not just fetched and discarded.
func TestBackendRelaySshProvisioner_ReadsCredentialFileFromSourceDevServer(t *testing.T) {
	pemKey, pub := genKeyPEM(t)
	server := startFakeSSHServer(t, "deploy", pub, false)
	bundlePath := writeLocalBundle(t, "// fake agent bundle\n")

	devServers := &fakeDevServers{}
	conns := &fakeConnections{nextID: "conn-ssh-1"}
	runtimes := &fakeRuntimes{}
	agentClient := devserveragent.New(devserveragent.DefaultConfig(), slog.Default())
	t.Cleanup(agentClient.Close)

	sourceDevServer, err := domain.NewDevServer("source-ds-1", "tenant-1", "source-host", domain.ConnectionModeDirectWebSocket, "")
	if err != nil {
		t.Fatalf("NewDevServer: %v", err)
	}
	credTransport := newFakeCredentialTransport()
	agentClient.AttachTransport(sourceDevServer.ID, sourceDevServer.Host, credTransport, devserveragent.HandshakeInfo{})

	provisioner := backendrelaysshprovisioner.NewProvisioner(
		devServers, conns, runtimes, agentClient,
		sshrelay.Config{BundlePath: bundlePath, HandshakeTimeout: 5 * time.Second, OrcaVersion: "test"},
		ephemeralsshconn.Config{DialTimeout: 5 * time.Second},
		sequentialIDs("id"), nil,
	)

	target := domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: server.port(t), Username: "deploy",
		IdentityFilePath: "/home/deploy/.ssh/id_ed25519",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var observed observedRPCCall
	go credTransport.respondToReadCredentialFile(t, pemKey, &observed)

	connectionID, err := provisioner.Provision(ctx, "tenant-1", "rt-1", sourceDevServer, target)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if connectionID != "conn-ssh-1" {
		t.Errorf("connectionID = %q, want conn-ssh-1", connectionID)
	}
	if observed.method != "vm.readCredentialFile" {
		t.Errorf("observed RPC method = %q, want vm.readCredentialFile", observed.method)
	}
	if observed.path != "/home/deploy/.ssh/id_ed25519" {
		t.Errorf("observed RPC path = %q, want target.IdentityFilePath unchanged", observed.path)
	}
}

// TestBackendRelaySshProvisioner_IdentityAgentSocket_SkipsCredentialFileRead
// is TASK-BE-EVM-017's regression guard: the identityAgent branch needs no
// ReadCredentialFile round-trip at all (only the socket PATH travels) —
// sourceDevServer here has NO attached session, so any attempt to call
// ReadCredentialFile against it would fail loudly (no live session for that
// dev server), making a successful Provision proof the call was skipped.
func TestBackendRelaySshProvisioner_IdentityAgentSocket_SkipsCredentialFileRead(t *testing.T) {
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

	server := startFakeSSHServer(t, "deploy", signer.PublicKey(), false)
	bundlePath := writeLocalBundle(t, "// fake agent bundle\n")

	devServers := &fakeDevServers{}
	conns := &fakeConnections{nextID: "conn-ssh-1"}
	runtimes := &fakeRuntimes{}
	agentClient := devserveragent.New(devserveragent.DefaultConfig(), slog.Default())
	t.Cleanup(agentClient.Close)

	// Deliberately NOT attached to agentClient — no live session exists for
	// this dev server at all.
	sourceDevServer, err := domain.NewDevServer("source-ds-2", "tenant-1", "source-host-2", domain.ConnectionModeDirectWebSocket, "")
	if err != nil {
		t.Fatalf("NewDevServer: %v", err)
	}

	provisioner := backendrelaysshprovisioner.NewProvisioner(
		devServers, conns, runtimes, agentClient,
		sshrelay.Config{BundlePath: bundlePath, HandshakeTimeout: 5 * time.Second, OrcaVersion: "test"},
		ephemeralsshconn.Config{DialTimeout: 5 * time.Second},
		sequentialIDs("id"), nil,
	)

	target := domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: server.port(t), Username: "deploy",
		IdentityAgentSocket: sockPath,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := provisioner.Provision(ctx, "tenant-1", "rt-1", sourceDevServer, target); err != nil {
		t.Fatalf("Provision: %v (a non-nil error here means it tried to call ReadCredentialFile against an unattached source dev server)", err)
	}
}

// TestBackendRelaySshProvisioner_CredentialFileContentNeverLogged is
// TASK-BE-EVM-017's core security regression-guard, mirroring
// ephemeralsshconn's TestEphemeralSshConnector_CredentialNeverLoggedOrPersisted
// convention exactly: static-scan provisioner.go's source, not a runtime
// log capture (this package's real logger is devserveragent's, which never
// receives the resolved contentPEM/target.PrivateKeyPEM value at all — see
// the source scan below for why that's structurally true, not just
// incidental).
func TestBackendRelaySshProvisioner_CredentialFileContentNeverLogged(t *testing.T) {
	src, err := os.ReadFile("provisioner.go")
	if err != nil {
		t.Fatalf("reading provisioner.go: %v", err)
	}
	text := string(src)

	if strings.Contains(text, `"log"`) || strings.Contains(text, `"log/slog"`) {
		t.Fatal("backendrelaysshprovisioner/provisioner.go must not import a logging package — credential material must never reach a log statement")
	}

	for i, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue // doc comments may legitimately name the field/variable
		}
		lower := strings.ToLower(line)
		mentionsFormatCall := strings.Contains(lower, "errorf(") || strings.Contains(lower, "sprintf(") ||
			strings.Contains(lower, "println(") || strings.Contains(lower, "print(")
		if mentionsFormatCall && (strings.Contains(line, ".PrivateKeyPEM") || strings.Contains(line, "contentPEM")) {
			t.Errorf("provisioner.go:%d appears to format credential material's VALUE into a string: %s", i+1, line)
		}
		if strings.Contains(line, "%+v") && strings.Contains(line, "target") {
			t.Errorf("provisioner.go:%d formats the whole target struct with %%+v, which would include credential material: %s", i+1, line)
		}
	}
}

// ─── TASK-BE-EVM-019: TOFU host-key fingerprint persistence (Hướng B) ──────

// TestBackendRelaySshProvisioner_PersistsFingerprintAfterFirstDial is
// TASK-BE-EVM-019's required Provisioner-level test: after a successful
// first dial (no prior EphemeralVmSshTargetRepository row for this
// runtime), Provision persists the REAL observed host-key fingerprint —
// not a placeholder, not left unset — keyed by (tenantID, runtimeID), so
// the NEXT dial for the same runtime has a baseline to verify against.
func TestBackendRelaySshProvisioner_PersistsFingerprintAfterFirstDial(t *testing.T) {
	pemKey, pub := genKeyPEM(t)
	server := startFakeSSHServer(t, "deploy", pub, false)
	bundlePath := writeLocalBundle(t, "// fake agent bundle\n")

	devServers := &fakeDevServers{}
	conns := &fakeConnections{nextID: "conn-ssh-1"}
	runtimes := &fakeRuntimes{}
	sshTargets := &fakeSshTargets{}
	agentClient := devserveragent.New(devserveragent.DefaultConfig(), slog.Default())
	t.Cleanup(agentClient.Close)

	provisioner := backendrelaysshprovisioner.NewProvisioner(
		devServers, conns, runtimes, agentClient,
		sshrelay.Config{BundlePath: bundlePath, HandshakeTimeout: 5 * time.Second, OrcaVersion: "test"},
		ephemeralsshconn.Config{DialTimeout: 5 * time.Second},
		sequentialIDs("id"), sshTargets,
	)

	target := domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: server.port(t), Username: "deploy", PrivateKeyPEM: pemKey,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := provisioner.Provision(ctx, "tenant-1", "rt-1", domain.DevServer{}, target); err != nil {
		t.Fatalf("Provision (first dial): %v", err)
	}

	if len(sshTargets.upserted) != 1 {
		t.Fatalf("expected exactly 1 upserted ssh target row, got %d", len(sshTargets.upserted))
	}
	rec := sshTargets.upserted[0]
	if rec.TenantID != "tenant-1" || rec.RuntimeID != "rt-1" {
		t.Errorf("unexpected upsert key: %+v", rec)
	}
	wantFingerprint := server.hostKeyFingerprint()
	if rec.HostKeyFingerprint != wantFingerprint {
		t.Errorf("HostKeyFingerprint = %q, want %q (the fake server's real host key fingerprint)", rec.HostKeyFingerprint, wantFingerprint)
	}
	if rec.HostKeyFingerprint == "" {
		t.Error("expected a non-empty fingerprint to be persisted after a successful first dial")
	}
}

// TestBackendRelaySshProvisioner_SecondDial_UsesStoredFingerprint proves
// Provision reads a PREVIOUSLY-persisted fingerprint back out and passes it
// to the connector as knownFingerprint — a reconnect to the SAME server
// (same host key) succeeds, and the stored row is re-written with the same
// value (idempotent).
func TestBackendRelaySshProvisioner_SecondDial_UsesStoredFingerprint(t *testing.T) {
	pemKey, pub := genKeyPEM(t)
	server := startFakeSSHServer(t, "deploy", pub, false)
	bundlePath := writeLocalBundle(t, "// fake agent bundle\n")

	devServers := &fakeDevServers{}
	conns := &fakeConnections{nextID: "conn-ssh-1"}
	runtimes := &fakeRuntimes{}
	sshTargets := &fakeSshTargets{byRuntime: map[string]domain.EphemeralVmSshTargetRecord{
		"rt-1": {TenantID: "tenant-1", RuntimeID: "rt-1", HostKeyFingerprint: server.hostKeyFingerprint()},
	}}
	agentClient := devserveragent.New(devserveragent.DefaultConfig(), slog.Default())
	t.Cleanup(agentClient.Close)

	provisioner := backendrelaysshprovisioner.NewProvisioner(
		devServers, conns, runtimes, agentClient,
		sshrelay.Config{BundlePath: bundlePath, HandshakeTimeout: 5 * time.Second, OrcaVersion: "test"},
		ephemeralsshconn.Config{DialTimeout: 5 * time.Second},
		sequentialIDs("id"), sshTargets,
	)

	target := domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: server.port(t), Username: "deploy", PrivateKeyPEM: pemKey,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := provisioner.Provision(ctx, "tenant-1", "rt-1", domain.DevServer{}, target); err != nil {
		t.Fatalf("Provision (second dial, matching stored fingerprint): %v", err)
	}
}
