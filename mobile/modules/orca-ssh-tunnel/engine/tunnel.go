// Package sshtunnel owns one cancellable SSH connection (optionally through a
// jump host) and a phone-loopback forward to a socket destination dialed by
// the SSH server.
package sshtunnel

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const connectTimeout = 15 * time.Second

// Tunnel must be allocated before dispatching Open so Close can cancel pending work.
type Tunnel struct {
	mu         sync.Mutex
	ctx        context.Context
	cancel     context.CancelFunc
	started    bool
	raw        net.Conn
	jumpRaw    net.Conn
	jumpClient *ssh.Client
	client     *ssh.Client
	listener   net.Listener
	sockets    map[net.Conn]struct{}
}

func NewTunnel() *Tunnel {
	ctx, cancel := context.WithCancel(context.Background())
	return &Tunnel{ctx: ctx, cancel: cancel, sockets: make(map[net.Conn]struct{})}
}

func (t *Tunnel) begin() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.started || t.ctx.Err() != nil {
		return errors.New("SSH_CANCELLED")
	}
	t.started = true
	return nil
}

type probeResult struct {
	Fingerprint     string `json:"fingerprint"`
	JumpFingerprint string `json:"jumpFingerprint"`
}

// Probe returns fingerprints as JSON: the target fingerprint always,
// jumpFingerprint when configured. No target credential is ever sent; reaching
// the target through a jump requires authenticating to the jump host itself.
func (t *Tunnel) Probe(raw string) (string, error) {
	if err := t.begin(); err != nil {
		return "", err
	}
	defer t.Close()
	c, err := parseConfiguration(raw)
	if err != nil {
		return "", err
	}
	result := probeResult{}
	_, err = t.handshake(c, nil, func(_ string, _ net.Addr, key ssh.PublicKey) error {
		result.Fingerprint = ssh.FingerprintSHA256(key)
		return errors.New("SSH_PROBE_COMPLETE")
	}, func(_ string, _ net.Addr, key ssh.PublicKey) error {
		result.JumpFingerprint = ssh.FingerprintSHA256(key)
		// Why: the jump handshake authenticates with saved credentials, so its
		// key must match the saved fingerprint before any secret is sent.
		if result.JumpFingerprint != c.Jump.HostKeyFingerprint {
			return errors.New("SSH_HOST_KEY_MISMATCH")
		}
		return nil
	}, func(string, string) {})
	if result.Fingerprint != "" {
		encoded, err := json.Marshal(result)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	}
	return "", err
}

type openStage struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type openResult struct {
	Endpoint string      `json:"endpoint"`
	Stages   []openStage `json:"stages"`
	Error    string      `json:"error,omitempty"`
}

// Open returns a phone-local WebSocket origin plus a stage log. The socket
// destination is dialed by the target SSH server, so its hostname resolves
// there.
func (t *Tunnel) Open(raw string) (string, error) {
	c, err := parseConfiguration(raw)
	if err != nil {
		return encodeOpenFailure(nil, err), nil
	}
	if !validHost(c.TargetHost, c.TargetPort) {
		return encodeOpenFailure(nil, errors.New("SSH_CONFIG_INVALID")), nil
	}
	if err = t.begin(); err != nil {
		return encodeOpenFailure(nil, err), nil
	}
	defer func() {
		if err != nil {
			t.Close()
		}
	}()
	var stages []openStage
	stage := func(code, message string) { stages = append(stages, openStage{Code: code, Message: message}) }
	// Why: Open always returns JSON so failures keep the stage log; the error
	// code travels in the result instead of the gobind error channel.
	fail := func(stageErr error) (string, error) {
		if stageErr != nil && stageErr.Error() != "" {
			stages = append(stages, openStage{Code: "failed", Message: stageErr.Error()})
		}
		return encodeOpenFailure(stages, stageErr), nil
	}
	auth, err := c.targetAuth()
	if err != nil {
		return fail(err)
	}
	mismatch := false
	client, err := t.handshake(c, auth, func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if ssh.FingerprintSHA256(key) != c.HostKeyFingerprint {
			mismatch = true
			return errors.New("SSH_HOST_KEY_MISMATCH")
		}
		return nil
	}, func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if ssh.FingerprintSHA256(key) != c.Jump.HostKeyFingerprint {
			mismatch = true
			return errors.New("SSH_HOST_KEY_MISMATCH")
		}
		return nil
	}, func(code, message string) {
		stages = append(stages, openStage{Code: code, Message: message})
	})
	if mismatch {
		return fail(errors.New("SSH_HOST_KEY_MISMATCH"))
	}
	if err != nil {
		return fail(err)
	}
	stage("connected", "SSH authenticated as "+c.Username+"@"+c.Host+":"+strconv.Itoa(c.Port))
	if c.Jump != nil {
		stage("jumped", "Reached the SSH server through "+c.Jump.Host)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fail(errors.New("SSH_LISTEN_FAILED"))
	}
	t.mu.Lock()
	if t.ctx.Err() != nil {
		t.mu.Unlock()
		listener.Close()
		return fail(errors.New("SSH_CANCELLED"))
	}
	t.listener = listener
	t.mu.Unlock()
	go t.accept(listener, client, c.destination())
	go func() { _ = client.Wait(); t.Close() }()
	stage("listening", "SSH server will connect to "+c.destination()+" — local forward on "+listener.Addr().String())
	return encodeOpenResult("ws://"+listener.Addr().String(), stages, ""), nil
}

func encodeOpenFailure(stages []openStage, stageErr error) string {
	return encodeOpenResult("", stages, errorCode(stageErr))
}

func encodeOpenResult(endpoint string, stages []openStage, code string) string {
	if stages == nil {
		// Why: a nil slice marshals to null, which the caller's schema rejects —
		// that would discard the error code below and every stage log with it.
		stages = []openStage{}
	}
	encoded, marshalErr := json.Marshal(openResult{
		Endpoint: endpoint,
		Stages:   stages,
		Error:    code,
	})
	if marshalErr != nil {
		return `{"error":"SSH_CONFIG_INVALID"}`
	}
	return string(encoded)
}

func errorCode(stageErr error) string {
	if stageErr == nil {
		return ""
	}
	return stageErr.Error()
}

// handshake connects to the target — through the jump host when configured —
// and authenticates. The target name resolves on the jump host when one is set.
func (t *Tunnel) handshake(c configuration, auth []ssh.AuthMethod, verifyTarget, verifyJump ssh.HostKeyCallback, stage func(code, message string)) (*ssh.Client, error) {
	ctx, cancel := context.WithTimeout(t.ctx, connectTimeout)
	defer cancel()
	if c.Jump != nil {
		stage("jump-dial", "Connecting to jump host "+c.Jump.address())
		raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", c.Jump.address())
		if err != nil {
			return nil, errors.New("SSH_JUMP_CONNECT_FAILED")
		}
		stage("jump-tcp", "TCP connected to jump host")
		t.mu.Lock()
		if t.ctx.Err() != nil {
			t.mu.Unlock()
			raw.Close()
			return nil, errors.New("SSH_CANCELLED")
		}
		t.jumpRaw = raw
		t.mu.Unlock()
		jumpAuth, err := c.Jump.auth()
		if err != nil {
			return nil, err
		}
		stage("jump-auth", "Authenticating to jump host as "+c.Jump.Username)
		jumpClient, err := t.sshClient(raw, c.Jump.address(), &ssh.ClientConfig{
			User: c.Jump.Username, Auth: jumpAuth, HostKeyCallback: verifyJump,
		})
		if err != nil {
			if t.ctx.Err() != nil {
				return nil, errors.New("SSH_CANCELLED")
			}
			// The host-key callback error is wrapped, so surface the mismatch
			// code rather than a generic jump handshake failure.
			if strings.Contains(err.Error(), "SSH_HOST_KEY_MISMATCH") {
				return nil, errors.New("SSH_HOST_KEY_MISMATCH")
			}
			if isClientAuthFailure(err) {
				return nil, errors.New("SSH_JUMP_AUTH_FAILED")
			}
			return nil, errors.New("SSH_JUMP_HANDSHAKE_FAILED")
		}
		stage("jump-authenticated", "Jump host authenticated")
		t.mu.Lock()
		t.jumpClient = jumpClient
		t.mu.Unlock()
	}
	raw, err := t.dialTargetStream(ctx, c, stage)
	if err != nil {
		return nil, err
	}
	stage("ssh-auth", "Authenticating to SSH server as "+c.Username)
	client, err := t.sshClient(raw, c.address(), &ssh.ClientConfig{
		User: c.Username, Auth: auth, HostKeyCallback: verifyTarget,
	})
	if err != nil {
		if isClientAuthFailure(err) {
			return nil, errors.New("SSH_AUTH_FAILED")
		}
		return nil, errors.New("SSH_HANDSHAKE_FAILED")
	}
	t.mu.Lock()
	if t.ctx.Err() != nil {
		t.mu.Unlock()
		client.Close()
		return nil, errors.New("SSH_CANCELLED")
	}
	t.client = client
	t.mu.Unlock()
	return client, nil
}

// dialTargetStream returns the TCP stream to the target. With a jump host the
// stream is a direct-tcpip channel, so the jump host resolves the target name.
func (t *Tunnel) dialTargetStream(ctx context.Context, c configuration, stage func(code, message string)) (net.Conn, error) {
	t.mu.Lock()
	// Why: Close nils this field from another goroutine; reading it unlocked can
	// panic on a nil *ssh.Client or silently dial the target from the phone.
	jumpClient := t.jumpClient
	t.mu.Unlock()
	if jumpClient == nil {
		stage("tcp-dial", "Connecting to SSH server "+c.address())
		raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", c.address())
		if err != nil {
			return nil, errors.New("SSH_CONNECT_FAILED")
		}
		t.mu.Lock()
		if t.ctx.Err() != nil {
			t.mu.Unlock()
			raw.Close()
			return nil, errors.New("SSH_CANCELLED")
		}
		t.raw = raw
		t.mu.Unlock()
		return raw, nil
	}
	// DialContext returns a net.Conn over the channel; the jump host resolves
	// the target name. Deadlines are enforced by the watchdog in sshClient
	// because channel-backed conns cannot carry TCP deadlines.
	stage("jump-resolve", "Asking jump host to connect to "+c.address())
	channel, err := jumpClient.DialContext(ctx, "tcp", c.address())
	if err != nil {
		return nil, errors.New("SSH_JUMP_DIAL_FAILED")
	}
	stage("jump-dialed", "Jump host reached "+c.address())
	return channel, nil
}

// isClientAuthFailure recognizes x/crypto's client-side authentication
// rejection, which is not surfaced as a typed ServerAuthError on the client.
func isClientAuthFailure(err error) bool {
	return strings.Contains(err.Error(), "unable to authenticate")
}

// sshClient runs the SSH handshake under a watchdog so a silent peer (or a
// stalled jump channel, which cannot carry TCP deadlines) cannot hang forever.
func (t *Tunnel) sshClient(raw net.Conn, address string, config *ssh.ClientConfig) (*ssh.Client, error) {
	ctx, cancel := context.WithTimeout(t.ctx, connectTimeout)
	defer cancel()
	type result struct {
		client *ssh.Client
		err    error
	}
	done := make(chan result, 1)
	go func() {
		conn, channels, requests, err := ssh.NewClientConn(raw, address, config)
		if err != nil {
			done <- result{err: err}
			return
		}
		done <- result{client: ssh.NewClient(conn, channels, requests)}
	}()
	select {
	case r := <-done:
		return r.client, r.err
	case <-ctx.Done():
		_ = raw.Close()
		// Drain so a late host-key callback cannot race this tunnel's teardown.
		<-done
		// Why: ctx carries the connect deadline, so a second timer would decide
		// the code at random and stay armed after the handshake returned.
		if t.ctx.Err() != nil {
			return nil, errors.New("SSH_CANCELLED")
		}
		return nil, errors.New("SSH_HANDSHAKE_FAILED")
	}
}

// Close is idempotent and never waits for workers or a peer to respond.
func (t *Tunnel) Close() {
	t.cancel()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.listener != nil {
		t.listener.Close()
		t.listener = nil
	}
	if t.raw != nil {
		t.raw.Close()
		t.raw = nil
	}
	if t.client != nil {
		t.client.Close()
		t.client = nil
	}
	if t.jumpClient != nil {
		t.jumpClient.Close()
		t.jumpClient = nil
	}
	if t.jumpRaw != nil {
		t.jumpRaw.Close()
		t.jumpRaw = nil
	}
	for socket := range t.sockets {
		socket.Close()
		delete(t.sockets, socket)
	}
}
