// Package devserveragent is infra-fleet-service's outbound adapter to the
// Dev Server Agent execution plane (agent/) — this service's "defining
// adapter" per specs/backend-go/services/infra-fleet-service.md §6.
//
// # Epic A status: all three connection modes are real
//
// Per §10 of the design doc ("Protocol decision: Option A"), a full
// implementation covers three connection modes (domain.ConnectionMode:
// relay-ssh, relay-websocket, direct-websocket) over the same
// 13-byte-framed JSON-RPC wire protocol (Stack B, relay-protocol.ts) — see
// frame.go/jsonrpc.go/session.go's doc comments for the line-by-line
// correspondence.
//
//   - relay-websocket: Orca dials out to the agent's own WebSocket server
//     (agent-connection-relay.ts), authenticating with a static
//     ORCA_AGENT_TOKEN bearer token.
//   - direct-websocket: the agent dials in to adapter/agentwsserver's
//     inbound WS server, authenticating with a single-use, SHA-256-hashed
//     token slot; a successful handshake there calls
//     Client.AttachInboundSession.
//   - relay-ssh: adapter/sshrelay resolves the DevServer's SSHTargetID,
//     opens a real Vault-cert-authenticated SSH connection
//     (adapter/sshconn), SFTP-deploys agent/out/agent.js, launches it over
//     the SSH exec channel in `--stdio` mode (a third agent-side connection
//     mode added specifically for this — see agent/src/relay/agent-connection-stdio.ts),
//     and runs the receiver-side agent.handshake exchange (no token check —
//     the SSH connection itself is the trust boundary, matching the design
//     doc §"relay-ssh" auth model). See Client.SshProvisioner's doc comment
//     for exactly what wires this in.
//
// Every mode ends up in the same place: a *session (session.go) holding a
// live Transport (transport.go) — relay-websocket/direct-websocket use a
// wsTransport, relay-ssh's Transport is implemented by adapter/sshrelay
// over the SSH exec channel's stdio (with its own incremental frame
// decoder, since unlike a WebSocket, SSH exec-channel stdio delivers
// arbitrary-sized chunks with no message boundary). Exec/Health are
// mode-agnostic from here — no relay-ssh-specific branch exists in either.
//
// # Method surface is a generic passthrough
//
// Exec is a generic passthrough (method string + params map) with no
// per-method translation layer, for every mode — see
// specs/agent/api/agent-rpc-catalog-*.md for the real catalog; wiring
// specific callers (e.g. wscompat's devServer.*/fleet.* channels) to
// specific method names is intentionally left to those call sites, not
// baked into this transport.
package devserveragent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"
)

// ErrConnectionModeNotImplemented is returned for a devServer.Mode this
// Client doesn't recognize, and for relay-ssh when no SshProvisioner was
// configured via WithRelaySSH — see the package doc comment.
var ErrConnectionModeNotImplemented = errors.New("devserveragent: connection mode not implemented — see package doc comment")

// SshProvisioner is relay-ssh mode's session-establishment port —
// implemented by adapter/sshrelay.Provisioner (deploy+launch+handshake over
// a real SSH connection). Provision must return a live, already-handshaked
// Transport and the agent's HandshakeInfo; Client.getOrProvisionSession
// attaches it exactly like the other two modes' connection-establishment
// paths. Defined here (consumer-side), not in adapter/sshrelay, per this
// codebase's Dependency Inversion convention (see e.g.
// usecase/ports.go's own doc comment on why a port is defined where it's
// consumed).
type SshProvisioner interface {
	Provision(ctx context.Context, devServer domain.DevServer) (Transport, HandshakeInfo, error)
}

// Client implements usecase.DevServerAgentClient for all three connection
// modes, keeping one persistent session per dev server ID (reused across
// calls; established lazily on first use). A dropped relay-websocket
// session recovers on its own via session.go's backgroundReconnect, with
// getOrCreateSession's lazy redial as the fallback for a call that arrives
// mid-backoff. direct-websocket/relay-ssh sessions are managedExternally —
// see session.go's doc comment on backgroundReconnect for why they don't
// auto-reconnect the same way.
type Client struct {
	cfg    Config
	logger *slog.Logger

	mu       sync.Mutex
	sessions map[string]*session

	// sshProvisioner is nil unless WithRelaySSH was passed to New —
	// relay-ssh mode returns ErrConnectionModeNotImplemented until it is.
	sshProvisioner SshProvisioner
}

// Option configures optional Client behavior beyond relay-websocket/
// direct-websocket, which need none — currently only WithRelaySSH.
type Option func(*Client)

// WithRelaySSH enables relay-ssh mode by supplying the provisioner that
// deploys/launches/attaches a session for a given DevServer — see
// adapter/sshrelay.Provisioner (the production implementation, over a real
// SSH connection via adapter/sshconn) and SshProvisioner's doc comment.
func WithRelaySSH(provisioner SshProvisioner) Option {
	return func(c *Client) {
		c.sshProvisioner = provisioner
	}
}

// New constructs a Client. cfg.Token (ORCA_AGENT_TOKEN) must be set for any
// relay-websocket dev server to be reachable — see Config's doc comment for
// why this is deployment-wide config rather than a per-DevServer field.
func New(cfg Config, logger *slog.Logger, opts ...Option) *Client {
	if logger == nil {
		logger = slog.Default()
	}
	c := &Client{cfg: cfg, logger: logger, sessions: make(map[string]*session)}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// getOrCreateSession returns devServer's persistent session, dispatching by
// connection mode.
func (c *Client) getOrCreateSession(ctx context.Context, devServer domain.DevServer) (*session, error) {
	switch devServer.Mode {
	case domain.ConnectionModeRelayWebSocket:
		return c.getOrDialSession(ctx, devServer)
	case domain.ConnectionModeDirectWebSocket:
		return c.getInboundSession(devServer)
	case domain.ConnectionModeRelaySSH:
		return c.getOrProvisionSession(ctx, devServer)
	default:
		return nil, fmt.Errorf("%w: devServer.Mode=%q", ErrConnectionModeNotImplemented, devServer.Mode)
	}
}

// getOrDialSession is relay-websocket's original path: create the session
// lazily on first use, (re)dial if the previous connection dropped.
func (c *Client) getOrDialSession(ctx context.Context, devServer domain.DevServer) (*session, error) {
	c.mu.Lock()
	sess, ok := c.sessions[devServer.ID]
	if !ok {
		sess = newSession(devServer.Host, c.cfg, c.logger)
		c.sessions[devServer.ID] = sess
	}
	c.mu.Unlock()

	if sess.isHandshaked() {
		return sess, nil
	}
	if err := sess.connect(ctx); err != nil {
		return nil, err
	}
	return sess, nil
}

// getInboundSession is direct-websocket's path. There is nothing to
// lazily (re)connect here — the agent must dial in on its own (via
// adapter/agentwsserver, which calls AttachInboundSession on success). An
// absent or dropped session is a real "not reachable right now" condition,
// not something this call can fix by dialing anywhere.
func (c *Client) getInboundSession(devServer domain.DevServer) (*session, error) {
	c.mu.Lock()
	sess, ok := c.sessions[devServer.ID]
	c.mu.Unlock()
	if !ok || !sess.isHandshaked() {
		return nil, fmt.Errorf("devserveragent: no live inbound connection from dev server %q (direct-websocket mode) — the agent must dial in first", devServer.ID)
	}
	return sess, nil
}

// getOrProvisionSession is relay-ssh's path: reuse an already-live session
// (a deployed+launched agent.js --stdio process bridged over one SSH
// connection) if one exists, otherwise ask the configured SshProvisioner to
// deploy/launch/handshake a fresh one. Unlike relay-websocket's redial,
// re-provisioning means a brand new SSH connection + SFTP deploy + process
// launch — real cost, which is exactly why a live session is reused
// whenever possible rather than re-provisioned per call.
func (c *Client) getOrProvisionSession(ctx context.Context, devServer domain.DevServer) (*session, error) {
	c.mu.Lock()
	sess, ok := c.sessions[devServer.ID]
	c.mu.Unlock()
	if ok && sess.isHandshaked() {
		return sess, nil
	}

	if c.sshProvisioner == nil {
		return nil, fmt.Errorf("%w: relay-ssh support was not enabled (see WithRelaySSH)", ErrConnectionModeNotImplemented)
	}
	t, info, err := c.sshProvisioner.Provision(ctx, devServer)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	sess, ok = c.sessions[devServer.ID]
	if !ok {
		sess = newSession(devServer.Host, c.cfg, c.logger)
		sess.managedExternally = true
		c.sessions[devServer.ID] = sess
	}
	c.mu.Unlock()

	sess.attachTransport(t, info)
	return sess, nil
}

// AttachTransport registers an already-established Transport as
// devServerID's live session — the Transport-level sibling of
// AttachInboundSession just below, for a caller that already holds a
// devserveragent.Transport directly instead of a raw *websocket.Conn.
//
// Added for TASK-BE-EVM-013 (not originally in that task's file list —
// discovered necessary during implementation): adapter/
// backendrelaysshprovisioner calls adapter/sshrelay.Provisioner.Provision
// directly (bypassing getOrProvisionSession/c.sshProvisioner, which is
// wired to the SHARED, Vault-cert-based relay-ssh provisioner for
// user-registered SSH targets — not reusable per-call with ephemeral,
// recipe-supplied credentials) and needs a way to hand the resulting
// Transport to this Client so later Exec/Health calls for that dev server
// find a live session, exactly like relay-ssh's own getOrProvisionSession
// path does internally via sess.attachTransport. Mirrors
// AttachInboundSession's shape 1:1; only the transport's origin differs.
func (c *Client) AttachTransport(devServerID, host string, transport Transport, info HandshakeInfo) {
	c.mu.Lock()
	sess, ok := c.sessions[devServerID]
	if !ok {
		sess = newSession(host, c.cfg, c.logger)
		sess.managedExternally = true
		c.sessions[devServerID] = sess
	}
	c.mu.Unlock()

	sess.attachTransport(transport, info)
}

// AttachInboundSession registers an already-authenticated inbound
// WebSocket connection as devServerID's live session — called by
// adapter/agentwsserver once its handshake + token-slot validation
// succeeds (direct-websocket mode: the agent dialed Orca, not the other
// way around). Reuses the exact same readLoop/keepAliveLoop/call machinery
// connect() uses for the outbound case; only how the transport/info was
// obtained differs. Safe to call again for a reconnecting agent — reuses
// the same session object so in-flight callers of Exec/Health naturally
// see the new live connection once attached.
func (c *Client) AttachInboundSession(devServerID, host string, conn *websocket.Conn, info HandshakeInfo) {
	c.mu.Lock()
	sess, ok := c.sessions[devServerID]
	if !ok {
		sess = newSession(host, c.cfg, c.logger)
		sess.managedExternally = true
		c.sessions[devServerID] = sess
	}
	c.mu.Unlock()

	sess.attachTransport(newWSTransport(conn, c.logger), info)
}

// Exec dispatches one JSON-RPC method call (e.g. "ports.scan",
// "preflight.check", "shell.exec") to the Dev Server Agent over devServer's
// resolved transport and decodes its JSON-RPC result into a map — the
// package doc comment's "method/params are passed through verbatim, no
// per-method translation" contract, uniform across all three modes.
func (c *Client) Exec(ctx context.Context, devServer domain.DevServer, method string, params map[string]any) (map[string]any, error) {
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return nil, err
	}
	result, err := sess.call(ctx, method, params)
	if err != nil {
		// JSON-RPC standard "method not found" (-32601): the agent answered,
		// it just doesn't implement method on this build — a permanent,
		// typed condition callers must distinguish from a transport/timeout
		// failure. See domain.ErrAgentMethodNotFound's doc comment.
		var rpcErr *JSONRPCError
		if errors.As(err, &rpcErr) && rpcErr.Code == jsonrpcMethodNotFoundCode {
			return nil, fmt.Errorf("%w: %v", domain.ErrAgentMethodNotFound, err)
		}
		return nil, err
	}
	if len(result) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(result, &out); err != nil {
		return nil, fmt.Errorf("devserveragent: decoding %q result: %w", method, err)
	}
	return out, nil
}

// Health performs a connect+handshake check (or reuses an already-live
// session) — distinct from the SSH-exec-based fleet health poll that
// usecase.GetFleetHealth reads from Postgres. A connect/provision failure
// of any kind is reported as (false, nil) — "not reachable" is the
// expected/common answer this method exists to give, not an error
// condition the caller must additionally branch on. Uniform across all
// three modes.
func (c *Client) Health(ctx context.Context, devServer domain.DevServer) (bool, error) {
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		c.logger.DebugContext(ctx, "devserveragent: health check unreachable", slog.String("devServerId", devServer.ID), slog.Any("error", err))
		return false, nil
	}
	return sess.isHandshaked(), nil
}

// IsConnected reports whether devServerID already has a live, handshaked
// session RIGHT NOW — a pure map peek, never dialing/provisioning a new one
// the way Health does. Health is right for its own call site
// (EstablishConnection, a deliberate connect-time reachability check where
// dialing IS the point); IsConnected is for callers that just want to know
// current status cheaply and safely in bulk (e.g. listing dev servers, or
// deciding whether a browse/detect action can relay anywhere at all) —
// calling Health per row there would risk a slow dial-out per
// not-yet-connected relay-websocket/relay-ssh row. direct-websocket mode
// (an inbound-only session, see getInboundSession) never dials regardless,
// so this is exactly as accurate as Health for that mode and just skips the
// unnecessary round trip for the other two.
func (c *Client) IsConnected(devServerID string) bool {
	c.mu.Lock()
	sess, ok := c.sessions[devServerID]
	c.mu.Unlock()
	return ok && sess.isHandshaked()
}

// Note: relay-ssh's liveness check is NOT a separate dial-and-probe path —
// Health above already covers it uniformly via getOrCreateSession's
// mode dispatch to getOrProvisionSession/sshProvisioner.Provision, the same
// as Exec. An earlier draft of this method had its own dialRelaySSH/
// relaySSHHealth pair against a sshConnector/sshTargetResolver field pair;
// that was superseded by the sshProvisioner abstraction above and dropped
// as dead code during TASK-192's merge.

// StreamPty subscribes to ptyID's pty.data/pty.exit/pty.replay notifications
// over devServer's persistent session (see session.go's subscribePty/
// routeNotification) and translates them into usecase.PtyEvent.
//
// relay-ssh is blocked below, but NOT because it lacks a persistent session
// or the pty.* JSON-RPC surface — it has both. getOrProvisionSession returns
// the same *session type as the other two modes, and
// agent-connection-stdio.ts's connectStdio() runs the exact same
// agent-session.ts/dispatcher.ts (same tool discovery, same pty.* handlers)
// as relay-websocket/direct-websocket, just over a duck-typed stdio
// transport instead of a real WebSocket (see that file's own header
// comment). BACKLOG-019 traced this: an earlier doc-comment revision here
// claimed the opposite ("no persistent session ... no relay.js deployed"),
// which directly contradicted this package's own doc comment
// ("every mode ends up in the same place") and getOrProvisionSession's doc
// comment — that claim was simply wrong, not a design decision.
// The block stays for now because nobody has verified pty.* notification
// delivery actually works end-to-end over the stdio duck-typed transport in
// a live relay-ssh dev server (StreamScreencast's identical-looking block a
// few methods down is unrelated — no CDP browser is deployed to a bare
// relay-ssh target regardless of JSON-RPC surface, that one's real). Lifting
// this block is a genuine behavior change, not a doc fix — do it only after
// testing pty streaming against a real relay-ssh dev server, and lift it
// for both this method and usecase.DevServerAgentClient.StreamExecOutput
// together (SOL-AG-FLOWTASK-001 §3 deliberately mirrored this gate there).
func (c *Client) StreamPty(ctx context.Context, devServer domain.DevServer, ptyID string) (<-chan usecase.PtyEvent, func(), error) {
	if devServer.Mode == domain.ConnectionModeRelaySSH {
		return nil, nil, fmt.Errorf("%w: relay-ssh pty.* streaming is unverified end-to-end, not architecturally unsupported — see this method's doc comment (BACKLOG-019)", ErrConnectionModeNotImplemented)
	}
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return nil, nil, err
	}

	raw := sess.subscribePty(ptyID)
	out := make(chan usecase.PtyEvent, 64)
	done := make(chan struct{})
	var closeOnce sync.Once

	go func() {
		defer close(out)
		for {
			select {
			case n, ok := <-raw:
				if !ok {
					return
				}
				out <- usecase.PtyEvent{PtyID: n.PtyID, Data: n.Data, Exited: n.Exited, ExitCode: n.ExitCode}
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	unsubscribe := func() {
		closeOnce.Do(func() {
			close(done)
			sess.unsubscribePty(ptyID, raw)
		})
	}
	return out, unsubscribe, nil
}

// StreamScreencast starts a browser.screencast capture and subscribes to
// its notifications — see usecase.DevServerAgentClient.StreamScreencast's
// doc comment for why this subscribes BEFORE issuing the start call
// (avoids a race where a fast browser.screencastReady notification arrives
// before subscribeScreencast has registered a channel for it).
func (c *Client) StreamScreencast(ctx context.Context, devServer domain.DevServer, params usecase.ScreencastParams) (<-chan usecase.ScreencastEvent, func(), error) {
	if devServer.Mode == domain.ConnectionModeRelaySSH {
		return nil, nil, fmt.Errorf("%w: relay-ssh mode has no browser.* JSON-RPC surface (no relay.js deployed)", ErrConnectionModeNotImplemented)
	}
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return nil, nil, err
	}

	raw := sess.subscribeScreencast(params.WorktreeID)

	if _, err := sess.call(ctx, "browser.screencastStart", screencastStartParams(params)); err != nil {
		sess.unsubscribeScreencast(params.WorktreeID, raw)
		return nil, nil, err
	}

	out := make(chan usecase.ScreencastEvent, 64)
	done := make(chan struct{})
	var closeOnce sync.Once

	go func() {
		defer close(out)
		for {
			select {
			case n, ok := <-raw:
				if !ok {
					return
				}
				out <- usecase.ScreencastEvent{
					Ready: n.Ready, SubscriptionID: n.SubscriptionID, BrowserPageID: n.BrowserPageID,
					Format: n.Format, Frame: n.Frame, Ended: n.Ended, ErrorMsg: n.ErrorMsg,
				}
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	unsubscribe := func() {
		closeOnce.Do(func() {
			close(done)
			sess.unsubscribeScreencast(params.WorktreeID, raw)
			// Best-effort: tell the agent to stop capturing — errors here
			// are non-fatal (the connection may already be gone, which is
			// exactly when unsubscribe is being called from).
			stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = sess.call(stopCtx, "browser.screencastStop", map[string]any{"worktreeId": params.WorktreeID})
		})
	}
	return out, unsubscribe, nil
}

// screencastStartParams builds browser.screencastStart's JSON-RPC params
// from usecase.ScreencastParams — field names match
// browser-screencast-handler.ts's dispatch case exactly (both sides of this
// contract were written together in this pass, not independently guessed).
func screencastStartParams(p usecase.ScreencastParams) map[string]any {
	params := map[string]any{
		"worktreeId":         p.WorktreeID,
		"page":               p.Page,
		"format":             p.Format,
		"quality":            p.Quality,
		"maxWidth":           p.MaxWidth,
		"maxHeight":          p.MaxHeight,
		"mobile":             p.Mobile,
		"everyNthFrame":      p.EveryNthFrame,
		"minFrameIntervalMs": p.MinFrameIntervalMs,
	}
	if p.ViewportWidth != nil {
		params["viewportWidth"] = *p.ViewportWidth
	}
	if p.ViewportHeight != nil {
		params["viewportHeight"] = *p.ViewportHeight
	}
	if p.DeviceScaleFactor != nil {
		params["deviceScaleFactor"] = *p.DeviceScaleFactor
	}
	return params
}

// vmProvisionParams builds vm.provision's JSON-RPC params — field names
// match agent-ephemeral-vm-handler.ts's VmProvisionParams/
// validateVmProvisionParams exactly (repoPath/command/recipeId/runtimeId),
// the same wire contract vm.exec already uses (TASK-BE-EVM-001).
func vmProvisionParams(p usecase.VmProvisionParams) map[string]any {
	return map[string]any{
		"repoPath":  p.RepoPath,
		"command":   p.Command,
		"recipeId":  p.RecipeID,
		"runtimeId": p.RuntimeID,
	}
}

// StreamVmProvision runs a recipe's provision command on the agent and
// streams its stdout/stderr/result back — see
// usecase.DevServerAgentClient.StreamVmProvision's doc comment for the wire
// shape. session.streamCall blocks for the dispatcher's immediate
// "stream.started" ack (or a dispatch-time error, e.g. method not found)
// before this method returns — the same "starting IS subscribing,
// synchronously" discipline StreamScreencast's sess.call(...,
// "browser.screencastStart", ...) uses, so a caller's very first failure
// mode (an agent build too old to have vm.provision) surfaces as a returned
// error here, not silently as the channel's first event.
func (c *Client) StreamVmProvision(ctx context.Context, devServer domain.DevServer, params usecase.VmProvisionParams) (<-chan usecase.VmProvisionEvent, func(), error) {
	if devServer.Mode == domain.ConnectionModeRelaySSH {
		return nil, nil, fmt.Errorf("%w: relay-ssh mode has no vm.* JSON-RPC surface (no relay.js deployed)", ErrConnectionModeNotImplemented)
	}
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return nil, nil, err
	}

	_, rest, complete, err := sess.streamCall(ctx, "vm.provision", vmProvisionParams(params))
	if err != nil {
		var rpcErr *JSONRPCError
		if errors.As(err, &rpcErr) && rpcErr.Code == jsonrpcMethodNotFoundCode {
			return nil, nil, fmt.Errorf("%w: %v", domain.ErrAgentMethodNotFound, err)
		}
		return nil, nil, err
	}

	out := make(chan usecase.VmProvisionEvent, 64)
	done := make(chan struct{})
	var closeOnce sync.Once
	unsubscribe := func() {
		closeOnce.Do(func() {
			close(done)
			complete()
		})
	}

	go func() {
		defer close(out)
		for {
			select {
			case resp, ok := <-rest:
				if !ok {
					return
				}
				if resp.Error != nil {
					// A JSON-RPC-level error frame mid-stream (e.g.
					// handleDisconnect's synthesized connection-lost error) —
					// terminal, unlike a semantic error carried inside a
					// stream.end frame's own result.error field (see
					// decodeVmProvisionFrame).
					select {
					case out <- usecase.VmProvisionEvent{Type: "error", ErrorMsg: resp.Error.Error()}:
					case <-done:
					}
					complete()
					return
				}
				event, terminal := decodeVmProvisionFrame(resp.Result)
				if event != nil {
					select {
					case out <- *event:
					case <-done:
						complete()
						return
					}
				}
				if terminal {
					complete()
					return
				}
			case <-done:
				return
			case <-ctx.Done():
				complete()
				return
			}
		}
	}()

	return out, unsubscribe, nil
}

// vmProvisionFrame is this adapter's decoding of one vm.provision response
// frame's `result` field — see handleVmProvision's doc comment
// (agent-ephemeral-vm-handler.ts) for the exact 3 frame shapes this mirrors.
type vmProvisionFrame struct {
	Type            string          `json:"type"` // "stream.started" | "stream.chunk" | "stream.end"
	Line            string          `json:"line"`
	Source          string          `json:"source"` // "stderr" when set, else stdout
	ExitCode        int             `json:"exitCode"`
	ProvisionResult json.RawMessage `json:"provisionResult"`
	Error           string          `json:"error"`
}

// vmProvisionResultEnvelope mirrors parseEphemeralVmRecipeResult's return
// shape ({ok:true,result:...}|{ok:false,error:string}) — the exact JSON
// handleVmProvision puts in a stream.end frame's "provisionResult" field.
type vmProvisionResultEnvelope struct {
	Ok     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// vmProvisionRecipeResult mirrors ephemeral-vm-recipes.ts's
// EphemeralVmRecipeResult union permissively (Go has no discriminated
// union): the legacy shape has pairingCode/projectRoot at the top level with
// no "connection" field (implicitly orca-server); the new shape carries an
// explicit "connection" object. See normalizeVmProvisionResult.
type vmProvisionRecipeResult struct {
	PairingCode string `json:"pairingCode"`
	ProjectRoot string `json:"projectRoot"`
	Connection  *struct {
		Type        string          `json:"type"`
		PairingCode string          `json:"pairingCode"`
		ProjectRoot string          `json:"projectRoot"`
		Target      json.RawMessage `json:"target"`
	} `json:"connection"`
}

// vmProvisionSshTargetWire mirrors EphemeralVmRecipeSshTargetSchema's wire
// fields consumed here (configHost/portForwards deliberately omitted, same
// cross-check as infrafleet.proto's EphemeralVmRecipeSshTarget message).
type vmProvisionSshTargetWire struct {
	Label                   string `json:"label"`
	Host                    string `json:"host"`
	Port                    int32  `json:"port"`
	Username                string `json:"username"`
	IdentityFile            string `json:"identityFile"`
	IdentityAgent           string `json:"identityAgent"`
	IdentitiesOnly          bool   `json:"identitiesOnly"`
	ProxyCommand            string `json:"proxyCommand"`
	JumpHost                string `json:"jumpHost"`
	RelayGracePeriodSeconds int32  `json:"relayGracePeriodSeconds"`
}

// decodeVmProvisionFrame demuxes one vm.provision response frame's `result`
// JSON into a usecase.VmProvisionEvent. Returns (nil, false) for
// "stream.started" (swallowed — see StreamVmProvision's doc comment);
// terminal=true only for "stream.end", whether it resolves to a "result" or
// an "error" event.
func decodeVmProvisionFrame(raw json.RawMessage) (event *usecase.VmProvisionEvent, terminal bool) {
	var f vmProvisionFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		e := usecase.VmProvisionEvent{Type: "error", ErrorMsg: fmt.Sprintf("devserveragent: decoding vm.provision frame: %v", err)}
		return &e, true
	}
	switch f.Type {
	case "stream.started":
		return nil, false
	case "stream.chunk":
		typ := "stdout"
		if f.Source == "stderr" {
			typ = "stderr"
		}
		e := usecase.VmProvisionEvent{Type: typ, Chunk: f.Line}
		return &e, false
	case "stream.end":
		return decodeVmProvisionStreamEnd(f), true
	default:
		return nil, false
	}
}

// decodeVmProvisionStreamEnd mirrors handleVmProvision's own precedence:
// its catch-block "error" field (agent-side exception, e.g. abort/timeout) >
// a non-zero exitCode (mirrors handleVmExec's convention) > provisionResult's
// own {ok:false,error} (a syntactically-valid-JSON-RPC but semantically
// invalid recipe result) > the normalized success result.
func decodeVmProvisionStreamEnd(f vmProvisionFrame) *usecase.VmProvisionEvent {
	if f.Error != "" {
		e := usecase.VmProvisionEvent{Type: "error", ErrorMsg: f.Error}
		return &e
	}
	if f.ExitCode != 0 {
		e := usecase.VmProvisionEvent{Type: "error", ErrorMsg: fmt.Sprintf("vm.provision exited %d", f.ExitCode)}
		return &e
	}
	if len(f.ProvisionResult) == 0 {
		e := usecase.VmProvisionEvent{Type: "error", ErrorMsg: "vm.provision: agent reported success with no provisionResult"}
		return &e
	}
	var env vmProvisionResultEnvelope
	if err := json.Unmarshal(f.ProvisionResult, &env); err != nil {
		e := usecase.VmProvisionEvent{Type: "error", ErrorMsg: fmt.Sprintf("devserveragent: decoding provisionResult: %v", err)}
		return &e
	}
	if !env.Ok {
		e := usecase.VmProvisionEvent{Type: "error", ErrorMsg: env.Error}
		return &e
	}
	result, err := normalizeVmProvisionResult(env.Result)
	if err != nil {
		e := usecase.VmProvisionEvent{Type: "error", ErrorMsg: fmt.Sprintf("devserveragent: decoding recipe result: %v", err)}
		return &e
	}
	e := usecase.VmProvisionEvent{Type: "result", Result: result}
	return &e
}

// normalizeVmProvisionResult mirrors ephemeral-vm-recipes.ts's
// getEphemeralVmRecipeResultConnection: the legacy result shape
// (pairingCode/projectRoot at the top level, no "connection" field) implies
// connection.type == "orca-server"; the new shape carries an explicit
// "connection" object.
func normalizeVmProvisionResult(raw json.RawMessage) (usecase.VmProvisionResult, error) {
	var r vmProvisionRecipeResult
	if err := json.Unmarshal(raw, &r); err != nil {
		return usecase.VmProvisionResult{}, err
	}
	if r.Connection == nil {
		return usecase.VmProvisionResult{Type: "orca-server", PairingCode: r.PairingCode, ProjectRoot: r.ProjectRoot}, nil
	}
	if r.Connection.Type == "ssh" {
		var wire vmProvisionSshTargetWire
		if len(r.Connection.Target) > 0 {
			if err := json.Unmarshal(r.Connection.Target, &wire); err != nil {
				return usecase.VmProvisionResult{}, err
			}
		}
		target := usecase.EphemeralVmRecipeSshTarget{
			Label: wire.Label, Host: wire.Host, Port: wire.Port, Username: wire.Username,
			IdentityFile: wire.IdentityFile, IdentityAgent: wire.IdentityAgent,
			IdentitiesOnly: wire.IdentitiesOnly, ProxyCommand: wire.ProxyCommand,
			JumpHost: wire.JumpHost, RelayGracePeriodSeconds: wire.RelayGracePeriodSeconds,
		}
		return usecase.VmProvisionResult{Type: "ssh", ProjectRoot: r.Connection.ProjectRoot, SshTarget: &target}, nil
	}
	return usecase.VmProvisionResult{Type: "orca-server", PairingCode: r.Connection.PairingCode, ProjectRoot: r.Connection.ProjectRoot}, nil
}

// Close tears down every open session — call on service shutdown.
func (c *Client) Close() {
	c.mu.Lock()
	sessions := c.sessions
	c.sessions = make(map[string]*session)
	c.mu.Unlock()
	for _, sess := range sessions {
		sess.close()
	}
}
