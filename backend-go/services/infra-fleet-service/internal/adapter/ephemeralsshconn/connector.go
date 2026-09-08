// Package ephemeralsshconn is Hướng B's (TASK-BE-EVM-013) auth layer for
// dialing a recipe-provisioned ephemeral VM SSH target — the sibling of
// adapter/sshconn's Vault-cert-authenticated Connect, but authenticating
// with recipe-supplied credential material (PrivateKeyPEM or
// IdentityAgentSocket) instead. See Connector's doc comment for the real,
// audited reason this package's Connect signature is shaped the way it is
// (locked to accepting — and ignoring — a domain.SshTarget parameter, to
// satisfy adapter/sshrelay.Provisioner's Connector port as-is).
package ephemeralsshconn

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/sshconn"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// defaultPort mirrors sshconn.defaultSSHPort — domain.EphemeralVmSshTarget.Port
// of 0 (recipe omitted it) dials the standard SSH port.
const defaultPort = 22

// Config tunes Connector's dial behavior — mirrors sshconn.Config's
// DialTimeout convention.
type Config struct {
	DialTimeout time.Duration
}

// DefaultConfig returns Config with the same conservative default
// sshconn.DefaultConfig uses.
func DefaultConfig() Config {
	return Config{DialTimeout: 10 * time.Second}
}

// LoadConfigFromEnv reads EPHEMERALSSHCONN_DIAL_TIMEOUT_MS on top of
// DefaultConfig — mirrors sshconn.LoadConfigFromEnv's identical
// override-one-knob-via-env shape.
func LoadConfigFromEnv() Config {
	cfg := DefaultConfig()
	if v := os.Getenv("EPHEMERALSSHCONN_DIAL_TIMEOUT_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			cfg.DialTimeout = time.Duration(ms) * time.Millisecond
		}
	}
	return cfg
}

// Connector implements adapter/sshrelay.Connector
// (`Connect(ctx, target domain.SshTarget) (*sshconn.Connection, error)`)
// for exactly ONE ephemeral SSH target, baked in at construction time
// (NewConnector) — a fresh Connector (and fresh SingleTargetResolver) is
// built per Provision call by adapter/backendrelaysshprovisioner, not
// shared/reused, because the target (and its credential) differs every
// call.
//
// Why Connect's signature still takes (and ignores) a domain.SshTarget:
// audited against the REAL source of adapter/sshrelay/provisioner.go
// (TASK-BE-EVM-013's mandatory "Bước 1"), not BE-SOL-EVM-004 §5b's sketch —
// that doc claims sshrelay.Connector is "an interface hẹp, KHÔNG khoá vào
// domain.SshTarget cụ thể". The real declaration in package sshrelay is:
//
//	type Connector interface {
//	    Connect(ctx context.Context, target domain.SshTarget) (*sshconn.Connection, error)
//	}
//
// — concretely typed to domain.SshTarget, which has no field for
// PrivateKeyPEM/IdentityAgentSocket/JumpHost/ProxyCommand/Port (see
// ssh_target.go: Host/UserName/VaultSSHRole only). There is structurally no
// way to route ephemeral credential material through that parameter. This
// Connector instead carries the real domain.EphemeralVmSshTarget
// internally (via NewConnector) and ignores whatever domain.SshTarget
// Provision's resolver.Get call happens to hand it — see
// SingleTargetResolver's doc comment for the paired half of this design.
type Connector struct {
	target domain.EphemeralVmSshTarget
	cfg    Config
	// knownFingerprint/observedFingerprint implement TOFU (trust-on-first-use)
	// host-key verification (TASK-BE-EVM-019, BE-SOL-EVM-004 §6d) — see
	// hostKeyCallback's doc comment for the full design.
	knownFingerprint    string
	observedFingerprint string
}

// NewConnector builds a Connector scoped to target — construct one fresh
// per Provision call. knownFingerprint is the SHA256 host-key fingerprint
// (ssh.FingerprintSHA256 format) persisted from this runtime's PREVIOUS
// successful dial, if any — "" means "no dial has ever succeeded for this
// runtime yet" (TOFU's first-use case, see hostKeyCallback). The caller
// (backendrelaysshprovisioner.Provisioner) is responsible for reading it
// from EphemeralVmSshTargetRepository before calling this, and for
// persisting ObservedFingerprint() after a successful Connect.
func NewConnector(target domain.EphemeralVmSshTarget, cfg Config, knownFingerprint string) *Connector {
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = DefaultConfig().DialTimeout
	}
	return &Connector{target: target, cfg: cfg, knownFingerprint: knownFingerprint}
}

// ObservedFingerprint returns the SHA256 fingerprint of the host key
// actually presented during the most recent Connect call that reached the
// host-key-verification step (set regardless of whether Connect ultimately
// succeeded — a mismatch still observes a fingerprint, it just also
// errors) — "" if Connect was never called. The caller persists this after
// a SUCCESSFUL Connect so the next dial for the same runtime has a
// knownFingerprint to compare against (see hostKeyCallback).
func (c *Connector) ObservedFingerprint() string {
	return c.observedFingerprint
}

// Connect dials c.target (ignoring the domain.SshTarget parameter — see
// Connector's doc comment), authenticating with c.target's
// IdentityAgentSocket if set, otherwise PrivateKeyPEM. NEVER logs
// target.PrivateKeyPEM/IdentityAgentSocket — every error and log path below
// mentions only addr/host, matching the security-review requirement this
// package's tests (TestEphemeralSshConnector_CredentialNeverLoggedOrPersisted)
// grep for.
func (c *Connector) Connect(ctx context.Context, _ domain.SshTarget) (*sshconn.Connection, error) {
	authMethod, err := c.authMethod()
	if err != nil {
		return nil, fmt.Errorf("ephemeralsshconn: building auth method: %w", err)
	}

	port := c.target.Port
	if port == 0 {
		port = defaultPort
	}
	addr := net.JoinHostPort(c.target.Host, strconv.Itoa(port))
	clientConfig := &ssh.ClientConfig{
		User:            c.target.Username,
		Auth:            []ssh.AuthMethod{authMethod},
		HostKeyCallback: c.hostKeyCallback(),
		Timeout:         c.cfg.DialTimeout,
	}

	var client *ssh.Client
	switch {
	case c.target.ProxyCommand != "":
		client, err = c.dialViaProxyCommand(ctx, addr, clientConfig)
	case c.target.JumpHost != "":
		client, err = c.dialViaJumpHost(ctx, addr, clientConfig)
	default:
		client, err = c.dialDirect(ctx, addr, clientConfig)
	}

	// Drop key material from memory now that it's no longer needed —
	// best-effort in-memory hygiene (Go offers no hard zeroing guarantee),
	// but ensures no LATER call on this same Connector instance can read it
	// again. BackendRelaySshProvisioner also never retains its own copy of
	// target past this call (TASK-BE-EVM-013 §"Credential không bao giờ rời
	// infra-fleet-service").
	c.target.PrivateKeyPEM = ""
	if err != nil {
		return nil, err
	}
	return sshconn.WrapClient(client), nil
}

// authMethod prefers IdentityAgentSocket (never routed through Vault) over
// PrivateKeyPEM, matching EphemeralVmRecipeSshTarget's identityFile/
// identityAgent mutual-optionality on the wire.
func (c *Connector) authMethod() (ssh.AuthMethod, error) {
	if c.target.IdentityAgentSocket != "" {
		return agentAuthMethod(c.target.IdentityAgentSocket)
	}
	if c.target.PrivateKeyPEM == "" {
		return nil, fmt.Errorf("ephemeralsshconn: target has neither identityAgent nor identityFile/PrivateKeyPEM set")
	}
	signer, err := ssh.ParsePrivateKey([]byte(c.target.PrivateKeyPEM))
	if err != nil {
		// Deliberately does not include the key bytes or ssh.ParsePrivateKey's
		// error (which can echo back malformed input) — parsing failures are
		// reported by shape only.
		return nil, fmt.Errorf("ephemeralsshconn: parsing private key: unparseable PEM")
	}
	return ssh.PublicKeys(signer), nil
}

// hostKeyCallback implements TOFU (trust-on-first-use) host-key
// verification (TASK-BE-EVM-019, BE-SOL-EVM-004 §6d — Gap 4), replacing
// ssh.InsecureIgnoreHostKey() for the FINAL target's own handshake only
// (dialViaJumpHost's separate jump-host handshake is deliberately left as
// ssh.InsecureIgnoreHostKey() — the recipe/schema has no separate
// fingerprint slot for a jump host, out of this task's scope, same "chốt
// phạm vi" as the doc comment at BE-SOL-EVM-004 §6d):
//   - c.knownFingerprint == "" (no successful dial recorded for this
//     runtime yet): accepts whatever key the target presents — the
//     caller reads ObservedFingerprint() after Connect succeeds and
//     persists it, so THIS dial's key becomes the trusted baseline.
//   - c.knownFingerprint != "": the presented key's SHA256 fingerprint
//     must match exactly — a mismatch is a hard failure
//     (INFRA_EPHEMERAL_VM_HOST_KEY_MISMATCH), never silently accepted
//     (a changed host key on a supposedly-already-known target is real
//     MITM suspicion, not a warning-level condition).
func (c *Connector) hostKeyCallback() ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		observed := ssh.FingerprintSHA256(key)
		c.observedFingerprint = observed
		if c.knownFingerprint == "" {
			return nil
		}
		if observed != c.knownFingerprint {
			return fmt.Errorf("INFRA_EPHEMERAL_VM_HOST_KEY_MISMATCH: host key changed for %s (expected %s, got %s)", hostname, c.knownFingerprint, observed)
		}
		return nil
	}
}

// agentAuthMethod dials a local ssh-agent UNIX socket and offers every
// identity it holds — mirrors the standard golang.org/x/crypto/ssh/agent
// PublicKeysCallback pattern. The dialed conn is intentionally not closed
// here: ssh.PublicKeysCallback's returned AuthMethod calls back into ag
// during the handshake this method's caller (Connect) runs immediately
// after, and closing eagerly would break that.
func agentAuthMethod(socketPath string) (ssh.AuthMethod, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("ephemeralsshconn: dialing ssh-agent socket: %w", err)
	}
	ag := agent.NewClient(conn)
	return ssh.PublicKeysCallback(ag.Signers), nil
}

func (c *Connector) dialDirect(ctx context.Context, addr string, clientConfig *ssh.ClientConfig) (*ssh.Client, error) {
	dialer := &net.Dialer{Timeout: c.cfg.DialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("ephemeralsshconn: dialing %s: %w", addr, err)
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, clientConfig)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ephemeralsshconn: SSH handshake with %s: %w", addr, err)
	}
	return ssh.NewClient(sshConn, chans, reqs), nil
}

// dialViaJumpHost double-hops through c.target.JumpHost — dial+handshake to
// the jump host first (same credential as the final target; the recipe
// carries no separate jump-host credential), then open a "direct-tcpip"
// channel THROUGH it to the real target and run a second SSH handshake over
// that channel. (*ssh.Client).Dial is golang.org/x/crypto/ssh's public API
// for opening that direct-tcpip channel — the Go equivalent of the TS
// reference's forwardOut() (SOL-AG-EVM-003 §2's "double-hop cho jumpHost,
// port sang Go, cùng ý tưởng").
func (c *Connector) dialViaJumpHost(ctx context.Context, targetAddr string, targetClientConfig *ssh.ClientConfig) (*ssh.Client, error) {
	jumpUser, jumpAddr := parseJumpHost(c.target.JumpHost, c.target.Username)
	jumpAuthMethod, err := c.authMethod()
	if err != nil {
		return nil, err
	}
	jumpConfig := &ssh.ClientConfig{
		User:            jumpUser,
		Auth:            []ssh.AuthMethod{jumpAuthMethod},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // same documented gap
		Timeout:         c.cfg.DialTimeout,
	}

	dialer := &net.Dialer{Timeout: c.cfg.DialTimeout}
	rawConn, err := dialer.DialContext(ctx, "tcp", jumpAddr)
	if err != nil {
		return nil, fmt.Errorf("ephemeralsshconn: dialing jump host %s: %w", jumpAddr, err)
	}
	jumpSSHConn, jumpChans, jumpReqs, err := ssh.NewClientConn(rawConn, jumpAddr, jumpConfig)
	if err != nil {
		_ = rawConn.Close()
		return nil, fmt.Errorf("ephemeralsshconn: SSH handshake with jump host %s: %w", jumpAddr, err)
	}
	jumpClient := ssh.NewClient(jumpSSHConn, jumpChans, jumpReqs)

	targetConn, err := jumpClient.Dial("tcp", targetAddr)
	if err != nil {
		_ = jumpClient.Close()
		return nil, fmt.Errorf("ephemeralsshconn: forwarding to %s via jump host: %w", targetAddr, err)
	}
	targetSSHConn, targetChans, targetReqs, err := ssh.NewClientConn(targetConn, targetAddr, targetClientConfig)
	if err != nil {
		_ = targetConn.Close()
		_ = jumpClient.Close()
		return nil, fmt.Errorf("ephemeralsshconn: SSH handshake with %s via jump host: %w", targetAddr, err)
	}
	// jumpClient is intentionally NOT closed on success — the target
	// connection's direct-tcpip channel is forwarded through it; closing it
	// would tear that channel down. A double-hop connection's resource
	// lifetime is inherently tied together this way.
	return ssh.NewClient(targetSSHConn, targetChans, targetReqs), nil
}

// parseJumpHost parses jumpHost's "[user@]host[:port]" ProxyJump-style
// syntax, defaulting user to defaultUser (the final target's username —
// the recipe carries no separate jump-host identity) and port to 22.
func parseJumpHost(jumpHost, defaultUser string) (user, addr string) {
	user = defaultUser
	hostPart := jumpHost
	if idx := strings.Index(jumpHost, "@"); idx >= 0 {
		user = jumpHost[:idx]
		hostPart = jumpHost[idx+1:]
	}
	if _, _, err := net.SplitHostPort(hostPart); err == nil {
		return user, hostPart
	}
	return user, net.JoinHostPort(hostPart, strconv.Itoa(defaultPort))
}

// dialViaProxyCommand runs c.target.ProxyCommand as a shell command and
// uses its stdin/stdout as the transport pipe for the SSH handshake —
// OpenSSH's ProxyCommand semantics (SOL-AG-EVM-003 §2's "spawn
// child_process cho proxyCommand", ported to Go's os/exec).
func (c *Connector) dialViaProxyCommand(ctx context.Context, addr string, clientConfig *ssh.ClientConfig) (*ssh.Client, error) {
	cmd := exec.CommandContext(ctx, "sh", "-c", c.target.ProxyCommand)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("ephemeralsshconn: opening proxyCommand stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ephemeralsshconn: opening proxyCommand stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ephemeralsshconn: starting proxyCommand: %w", err)
	}

	pipe := &proxyCommandConn{stdin: stdin, stdout: stdout, cmd: cmd}
	sshConn, chans, reqs, err := ssh.NewClientConn(pipe, addr, clientConfig)
	if err != nil {
		_ = pipe.Close()
		return nil, fmt.Errorf("ephemeralsshconn: SSH handshake over proxyCommand: %w", err)
	}
	return ssh.NewClient(sshConn, chans, reqs), nil
}

// proxyCommandConn adapts a spawned process's stdin/stdout pipes to
// net.Conn, the interface ssh.NewClientConn requires — deadlines are no-ops
// (pipes to a live subprocess have no OS-level deadline primitive) and
// Local/RemoteAddr are placeholders (never a real network address).
type proxyCommandConn struct {
	stdin  io.WriteCloser
	stdout io.ReadCloser
	cmd    *exec.Cmd
}

func (p *proxyCommandConn) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *proxyCommandConn) Write(b []byte) (int, error) { return p.stdin.Write(b) }

func (p *proxyCommandConn) Close() error {
	_ = p.stdin.Close()
	_ = p.stdout.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	_ = p.cmd.Wait()
	return nil
}

func (p *proxyCommandConn) LocalAddr() net.Addr             { return proxyCommandAddr{} }
func (p *proxyCommandConn) RemoteAddr() net.Addr            { return proxyCommandAddr{} }
func (p *proxyCommandConn) SetDeadline(time.Time) error     { return nil }
func (p *proxyCommandConn) SetReadDeadline(time.Time) error { return nil }
func (p *proxyCommandConn) SetWriteDeadline(time.Time) error {
	return nil
}

type proxyCommandAddr struct{}

func (proxyCommandAddr) Network() string { return "proxyCommand" }
func (proxyCommandAddr) String() string  { return "proxyCommand" }

// SingleTargetResolver implements adapter/sshrelay.SshTargetResolver
// (`Get(ctx, tenantID, id) (domain.SshTarget, error)`) by always returning
// one pre-built placeholder domain.SshTarget, ignoring tenantID/id —
// TASK-BE-EVM-013's audited answer to "does sshrelay.Provisioner.Provision
// need a real Postgres-backed ssh_target_id lookup, or can this be
// skipped": Provision only requires devServer.SSHTargetID to be non-empty
// (so it calls resolver.Get() at all — see provisioner.go:83-85) and passes
// whatever Get returns straight into Connector.Connect, which (for THIS
// package's Connector) ignores it entirely. This resolver exists only to
// satisfy sshrelay.Provisioner's call shape; its return value carries no
// auth material (domain.SshTarget has no field for it) — the real target
// lives in Connector instead.
type SingleTargetResolver struct {
	Target domain.SshTarget
}

// Get always returns r.Target, regardless of tenantID/id.
func (r SingleTargetResolver) Get(_ context.Context, _, _ string) (domain.SshTarget, error) {
	return r.Target, nil
}
