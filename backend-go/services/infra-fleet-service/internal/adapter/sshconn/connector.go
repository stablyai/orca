// Package sshconn is the connection-establishment half of relay-ssh mode —
// generating an ephemeral SSH keypair, exchanging it for a Vault-signed
// short-lived certificate, and dialing a real SSH connection to a
// domain.SshTarget, per the "Preferred: Vault's SSH secrets engine" model in
// specs/backend-go/services/infra-fleet-service.md §9.
//
// Connection.SFTPClient/NewSession are what adapter/sshrelay builds its
// deploy (SFTP-upload agent/out/agent.js) and launch (SSH exec channel,
// `node agent.js --stdio`) steps on, over this same already-authenticated
// connection — see that package's doc comment for the rest of relay-ssh
// mode, which this package only establishes the transport for.
//
// Known, deliberate gaps carried forward from this pass (not silently
// matched — flagged here and at each call site below):
//   - Host-key verification: HostKeyCallback is ssh.InsecureIgnoreHostKey().
//     This is NOT a security fix over the TS reference, which also performs
//     no host-key verification (confirmed by research on the TS system this
//     service replaces) — it is the same gap, carried forward on purpose
//     rather than silently matched without comment. A real fix needs a
//     known-hosts fingerprint on domain.SshTarget plus a verification
//     policy, out of scope for this pass.
//   - Port: domain.SshTarget has no port field in this scaffold (see
//     ssh_target.go's doc comment) — Connect always dials target.Host on
//     port 22 (defaultSSHPort below). A per-target port needs a
//     domain/migration change, not invented here.
package sshconn

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// defaultSSHPort is Config.Port's default. domain.SshTarget carries no port
// field in this scaffold (see ssh_target.go's doc comment), so every target
// dials this same port unless Config.Port is overridden — a real, deliberate
// gap (see package doc comment), not an oversight. Config.Port exists mainly
// so tests can point Connect at a local fake server on an OS-assigned port;
// a real per-target port needs a domain/migration change, not invented here.
const defaultSSHPort = 22

// SSHCertIssuer is the narrow port sshconn needs from common/secrets —
// defined here (consumer-side), not in common/secrets, per this codebase's
// existing Dependency Inversion convention (see e.g.
// infra-fleet-service/internal/usecase/ports.go's own doc comment on why
// ports are defined where they're consumed, not where they're implemented).
type SSHCertIssuer interface {
	// SSHSignPublicKey signs publicKeyOpenSSH under the named Vault SSH
	// secrets engine role, returning a short-lived signed certificate in
	// OpenSSH authorized-key format. See common/secrets.Client's method of
	// the same name, which is what production wires in here.
	SSHSignPublicKey(ctx context.Context, role, publicKeyOpenSSH string) (string, error)
}

// Config tunes Connector's dial behavior — mirrors
// adapter/devserveragent.Config's Config/DefaultConfig()/LoadConfigFromEnv()
// convention (see config.go there) rather than hardcoding magic numbers.
type Config struct {
	// DialTimeout bounds TCP connect plus the SSH handshake (key exchange +
	// certificate auth) to the target host.
	DialTimeout time.Duration
	// Port is the TCP port Connect dials on target.Host. Defaults to 22
	// (defaultSSHPort) via DefaultConfig — domain.SshTarget has no port
	// field in this scaffold, so this is the one knob standing in for it
	// until a real per-target port lands (domain/migration change, out of
	// scope here). Mainly exists so tests can point Connect at a local fake
	// server on an OS-assigned port instead of the real port 22.
	Port int
}

// DefaultConfig returns Config with a conservative default dial timeout and
// the standard SSH port; callers override as needed.
func DefaultConfig() Config {
	return Config{
		DialTimeout: 10 * time.Second,
		Port:        defaultSSHPort,
	}
}

// LoadConfigFromEnv reads SSHCONN_DIAL_TIMEOUT_MS on top of DefaultConfig —
// same override-one-knob-via-env shape as devserveragent.LoadConfigFromEnv.
// Port is deliberately not env-configurable: it's a per-target concern that
// belongs on domain.SshTarget once that field exists, not a deployment-wide
// setting.
func LoadConfigFromEnv() Config {
	cfg := DefaultConfig()
	if v := os.Getenv("SSHCONN_DIAL_TIMEOUT_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			cfg.DialTimeout = time.Duration(ms) * time.Millisecond
		}
	}
	return cfg
}

// Connector establishes real SSH connections to domain.SshTarget hosts,
// authenticating with an ephemeral keypair + Vault-signed certificate —
// never a stored or reused private key. See package doc comment for scope.
type Connector struct {
	issuer SSHCertIssuer
	cfg    Config
}

// NewConnector builds a Connector. issuer is typically a *secrets.Client
// (common/secrets), narrowed to the SSHCertIssuer port here per this
// codebase's Dependency Inversion convention. A zero-value cfg.Port defaults
// to defaultSSHPort (22), same as DefaultConfig().
func NewConnector(issuer SSHCertIssuer, cfg Config) *Connector {
	if cfg.Port == 0 {
		cfg.Port = defaultSSHPort
	}
	return &Connector{issuer: issuer, cfg: cfg}
}

// Connect establishes a real SSH connection to target:
//  1. generates an ephemeral ed25519 keypair in-memory (never persisted,
//     never logged);
//  2. requests issuer.SSHSignPublicKey(ctx, target.VaultSSHRole, <marshaled
//     pubkey>) to get a short-lived certificate;
//  3. builds an ssh.ClientConfig using ssh.NewCertSigner over the ephemeral
//     private key + signed cert;
//  4. dials target.Host:<c.cfg.Port> (defaults to 22 — see package doc
//     comment: no per-target port on domain.SshTarget, no host-key
//     verification — both deliberate, documented gaps this pass doesn't
//     address).
func (c *Connector) Connect(ctx context.Context, target domain.SshTarget) (*Connection, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("sshconn: generating ephemeral keypair: %w", err)
	}

	signer, err := ssh.NewSignerFromSigner(priv)
	if err != nil {
		return nil, fmt.Errorf("sshconn: wrapping ephemeral private key: %w", err)
	}
	pubKeySSH, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, fmt.Errorf("sshconn: marshaling ephemeral public key: %w", err)
	}
	authorizedKey := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pubKeySSH)))

	signedCert, err := c.issuer.SSHSignPublicKey(ctx, target.VaultSSHRole, authorizedKey)
	if err != nil {
		return nil, fmt.Errorf("sshconn: requesting Vault SSH cert for role %s: %w", target.VaultSSHRole, err)
	}
	if strings.TrimSpace(signedCert) == "" {
		return nil, fmt.Errorf("sshconn: Vault returned an empty signed certificate for role %s", target.VaultSSHRole)
	}

	certPubKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(signedCert))
	if err != nil {
		return nil, fmt.Errorf("sshconn: parsing Vault-signed certificate: %w", err)
	}
	cert, ok := certPubKey.(*ssh.Certificate)
	if !ok {
		return nil, fmt.Errorf("sshconn: Vault response for role %s was not an SSH certificate", target.VaultSSHRole)
	}

	certSigner, err := ssh.NewCertSigner(cert, signer)
	if err != nil {
		return nil, fmt.Errorf("sshconn: building certificate signer: %w", err)
	}

	clientConfig := &ssh.ClientConfig{
		User:            target.UserName,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(certSigner)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec // deliberate, documented gap — see package doc comment
		Timeout:         c.cfg.DialTimeout,
	}

	addr := net.JoinHostPort(target.Host, strconv.Itoa(c.cfg.Port))
	dialer := &net.Dialer{Timeout: c.cfg.DialTimeout}
	rawConn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("sshconn: dialing %s: %w", addr, err)
	}

	sshConn, chans, reqs, err := ssh.NewClientConn(rawConn, addr, clientConfig)
	if err != nil {
		_ = rawConn.Close()
		return nil, fmt.Errorf("sshconn: SSH handshake with %s: %w", addr, err)
	}

	return &Connection{client: ssh.NewClient(sshConn, chans, reqs)}, nil
}

// Connection wraps a live, authenticated SSH connection to one target.
type Connection struct {
	client *ssh.Client
}

// WrapClient builds a Connection from an already-dialed *ssh.Client —
// TASK-BE-EVM-013's minimal, non-invasive addition for
// adapter/ephemeralsshconn (a different package, different auth flow:
// recipe-provided PrivateKeyPEM/IdentityAgentSocket, never Vault-cert-based
// like this package's own Connect). Does NOT change Connect() or anything
// else in this file — every other sshrelay/sshconn caller is unaffected.
func WrapClient(client *ssh.Client) *Connection {
	return &Connection{client: client}
}

// RunCommand runs cmd in a fresh SSH session and returns its stdout/stderr —
// the "verify this connection is actually alive and can execute something"
// primitive a future relay-ssh deploy step (or a simple health check) would
// build on. NOT wired into GetFleetHealth or any other usecase this pass —
// see this package's doc comment for why.
func (conn *Connection) RunCommand(ctx context.Context, cmd string) (stdout, stderr string, err error) {
	session, err := conn.client.NewSession()
	if err != nil {
		return "", "", fmt.Errorf("sshconn: opening session: %w", err)
	}
	defer func() { _ = session.Close() }()

	var stdoutBuf, stderrBuf bytes.Buffer
	session.Stdout = &stdoutBuf
	session.Stderr = &stderrBuf

	done := make(chan error, 1)
	go func() { done <- session.Run(cmd) }()

	select {
	case <-ctx.Done():
		_ = session.Close()
		return stdoutBuf.String(), stderrBuf.String(), fmt.Errorf("sshconn: run command %q: %w", cmd, ctx.Err())
	case runErr := <-done:
		if runErr != nil {
			return stdoutBuf.String(), stderrBuf.String(), fmt.Errorf("sshconn: run command %q: %w", cmd, runErr)
		}
		return stdoutBuf.String(), stderrBuf.String(), nil
	}
}

// Close closes the underlying SSH connection.
func (conn *Connection) Close() error {
	return conn.client.Close()
}

// NewSession opens a fresh SSH session over this connection — the
// lower-level primitive RunCommand itself uses, exposed so
// adapter/sshrelay can drive an exec channel directly (wiring its own
// Stdin/Stdout pipes for the agent.js --stdio process) instead of
// RunCommand's own buffer-and-wait shape, which doesn't fit a long-lived
// bidirectional process.
func (conn *Connection) NewSession() (*ssh.Session, error) {
	session, err := conn.client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("sshconn: opening session: %w", err)
	}
	return session, nil
}

// SFTPClient opens an SFTP subsystem client over this connection —
// adapter/sshrelay's deploy step uses it to upload agent/out/agent.js.
// Callers must Close() the returned client when done.
func (conn *Connection) SFTPClient() (*sftp.Client, error) {
	client, err := sftp.NewClient(conn.client)
	if err != nil {
		return nil, fmt.Errorf("sshconn: opening sftp client: %w", err)
	}
	return client, nil
}
