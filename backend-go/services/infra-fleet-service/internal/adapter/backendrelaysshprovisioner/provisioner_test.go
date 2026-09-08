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
	srv := &fakeSSHServer{listener: listener, deployDir: t.TempDir(), badChecksum: badChecksum}
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
		sequentialIDs("id"),
	)

	target := domain.EphemeralVmSshTarget{
		Host: "127.0.0.1", Port: server.port(t), Username: "deploy", PrivateKeyPEM: pemKey,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connectionID, err := provisioner.Provision(ctx, "tenant-1", "rt-1", target)
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
		sequentialIDs("id"),
	)

	target := domain.EphemeralVmSshTarget{Host: "127.0.0.1", Port: server.port(t), Username: "deploy", PrivateKeyPEM: pemKey}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := provisioner.Provision(ctx, "tenant-1", "rt-1", target); err != nil {
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
		sshrelay.Config{}, ephemeralsshconn.Config{}, sequentialIDs("id"),
	)

	_, err := provisioner.Provision(context.Background(), "tenant-1", "rt-1", domain.EphemeralVmSshTarget{})
	if err == nil {
		t.Fatal("expected Provision to fail fast when target.Host is empty")
	}
	if len(devServers.registered) != 0 {
		t.Error("expected no dev server registration attempt when the target is invalid")
	}
}
