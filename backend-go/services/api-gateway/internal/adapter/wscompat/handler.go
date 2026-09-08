package wscompat

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// SessionValidator resolves the caller's identity from the orca_session
// cookie on the WS upgrade request — implemented for real by
// internal/adapter/authclient against auth-service.ValidateSession (not the
// unverified-JWT usecase.AuthValidator placeholder, since the cookie holds
// a raw session token, never a JWT). Kept as an interface here so this
// handler is unit-testable without a real auth-service connection.
type SessionValidator interface {
	ValidateCookie(ctx context.Context, r *http.Request) (Identity, error)
}

// wsCloseAuthRequired mirrors the old TS backend's WsSessionRouter exactly
// (backend/src/main/session/ws-session-router.ts:
// `ws.close(4401, 'Authentication required. Please log in first.')`) — a
// custom WebSocket close code in the 4000-4999 application range, sent
// AFTER the WS handshake completes, not an HTTP-level rejection.
//
// This distinction is load-bearing, not cosmetic: frontend/'s
// WebSocketRpcClient.connectInternal() resolves connect()'s promise on
// ws.onopen (i.e. on a successful 101 handshake) — it does not wait to see
// whether the server closes moments later. bootstrapWebApp() awaits
// client.connect() BEFORE ever rendering WebRootBoundary (where the real
// /auth/me check + LoginPage live) — see main-web-bootstrap.tsx. Rejecting
// the upgrade itself with an HTTP 401 (this handler's first version, found
// wrong live on 2026-08-17) makes connect() reject, bootstrapWebApp()
// retries a few times and then renders a hard "Cannot connect to Orca
// backend" error screen — the user can NEVER reach the login page, because
// bootstrap never gets past the WS-connect step. Always completing the
// handshake and closing with 4401 afterward is what lets bootstrap
// proceed to WebRootBoundary, which then correctly shows LoginPage for an
// unauthenticated session. installAuthFailedRedirect() (main-web-bootstrap.tsx)
// is the client-side handler for this same code once already logged in
// (session expiry mid-use), not just first boot.
const wsCloseAuthRequired websocket.StatusCode = 4401

// Handler serves /ws: ALWAYS completes the WS handshake (matching
// WsSessionRouter — see wsCloseAuthRequired's doc comment for why this is
// load-bearing, not a relaxed security posture), resolves the session
// cookie, and either closes with code 4401 if invalid/absent or proceeds
// to the normal read/dispatch loop, writing back
// ResultMessage/ErrorMessage per the wire format in envelope.go.
type Handler struct {
	Logger   *slog.Logger
	Auth     SessionValidator
	Registry *Registry
}

func New(logger *slog.Logger, auth SessionValidator, registry *Registry) *Handler {
	return &Handler{Logger: logger, Auth: auth, Registry: registry}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// InsecureSkipVerify: see wsbridge.Handler's identical note — no
	// CORS/origin allow-list wired yet in this scaffold pass.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		h.Logger.ErrorContext(r.Context(), "wscompat: ws upgrade failed", slog.Any("error", err))
		return
	}
	defer conn.CloseNow()

	identity, err := h.Auth.ValidateCookie(r.Context(), r)
	if err != nil {
		_ = conn.Close(wsCloseAuthRequired, "Authentication required. Please log in first.")
		return
	}

	// terminalStreamsContext attaches a fresh, connection-scoped
	// terminalStreamRegistry (channels_terminal.go) so terminal.create's
	// StreamChannelHandler and the terminal.send/resize/close ChannelHandlers
	// that follow it on THIS connection can find each other's open AttachPty
	// streams — without leaking pty_ids across unrelated connections that
	// happen to attach the same pty_id (see channels_terminal.go's package
	// doc comment).
	ctx := terminalStreamsContext(r.Context(), newTerminalStreamRegistry())
	// binaryStreamRouterContext attaches a fresh, connection-scoped
	// binaryStreamRouter (binary_stream_registry.go) so terminal.multiplex
	// (and any future binary-framed channel) can demux inbound WS binary
	// frames by StreamID without a StreamID collision across unrelated
	// connections — same per-connection principle as terminalStreamsContext
	// just above.
	ctx = binaryStreamRouterContext(ctx, newBinaryStreamRouter())
	// terminalJSONSubscribeContext attaches a fresh, connection-scoped
	// terminalJsonSubscribeRegistry (channels_terminal_subscribe.go) so
	// terminal.unsubscribe can find and cancel the right terminal.subscribe
	// call's AttachPty stream on THIS connection — same per-connection
	// principle as terminalStreamsContext above.
	ctx = terminalJSONSubscribeContext(ctx, newTerminalJSONSubscribeRegistry())
	// provisionStreamsContext attaches a fresh, connection-scoped
	// provisionStreamRegistry (provision_stream_registry.go) so
	// ephemeralVm.provision's StreamChannelHandler and
	// ephemeralVm.cancelProvision can find each other's open
	// StreamVmProvision streams on THIS connection — same per-connection
	// principle as terminalStreamsContext above (TASK-BE-EVM-005).
	ctx = provisionStreamsContext(ctx, newProvisionStreamRegistry())

	// writeMu serializes writes to conn — coder/websocket, like most WS
	// libraries, does not allow concurrent writers on one connection. Reads
	// stay on this single goroutine (wsjson.Read below); every dispatched
	// invoke/send runs in its OWN goroutine (see handleInvoke/handleSend)
	// so one slow or hanging channel handler can no longer starve every
	// other in-flight request on the same connection — see the
	// "Concurrency" doc comment above ServeHTTP's declaration... actually
	// documented here since this is where the bug lived: found live
	// 2026-08-17 (docs/execution-plan.md §7) as
	// "Request timed out: preflight.check" — this loop used to read one
	// message, fully process it INLINE (including a downstream gRPC call
	// with no context deadline), and only then read the next message. Any
	// slow/unreachable downstream blocked every subsequent message on that
	// connection, including totally unrelated channels, until the client's
	// own 30s invoke timeout gave up. Reading and dispatching are now
	// decoupled: this loop's only job is to keep reading.
	var writeMu sync.Mutex

	for {
		// Read raw frames (not wsjson.Read) so a WS BINARY message —
		// terminal.multiplex's opcode-framed sub-protocol
		// (terminal_stream_frame.go) — never reaches json.Unmarshal. Before
		// this change, ANY binary frame on this connection made wsjson.Read
		// try to JSON-decode raw multiplex bytes, fail, and close the
		// connection (websocket.StatusInvalidFramePayloadData) — silently
		// breaking every other channel on the same connection too.
		typ, data, err := conn.Read(ctx)
		if err != nil {
			// Normal on client disconnect/navigation — not logged as an error.
			return
		}

		if typ == websocket.MessageBinary {
			frame, ferr := DecodeTerminalStreamFrame(data)
			if ferr != nil {
				h.Logger.WarnContext(ctx, "wscompat: dropping malformed binary frame", slog.Any("error", ferr))
				continue
			}
			// Dispatched in its own goroutine, same as every JSON invoke/send
			// below — a Subscribe frame's AttachPty call (or any other slow
			// handler) must not block reading the NEXT frame on this
			// connection, including frames for other streamIds (the exact
			// class of bug ServeHTTP's own "Concurrency" comment documents
			// for the JSON path).
			if router := binaryStreamRouterFromContext(ctx); router != nil {
				go router.dispatch(frame)
			}
			continue
		}

		var msg InboundMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			// Matches wsjson.Read's own failure behavior (see its doc
			// comment) for a text frame that isn't valid JSON.
			_ = conn.Close(websocket.StatusInvalidFramePayloadData, "failed to unmarshal JSON")
			return
		}

		// Detect WebSessionClient's dialect ONCE here — see
		// normalizeInboundMessage's doc comment (session_dialect.go) for why
		// the rest of this loop and handleInvoke/handleSubscribe never need
		// to re-detect it. A native message (including type-less garbage)
		// passes through unchanged.
		msgDialect, msg := normalizeInboundMessage(msg)

		switch msg.Type {
		case "invoke":
			if sh, ok := h.Registry.StreamHandlerFor(msg.Channel); ok {
				go h.handleSubscribe(ctx, conn, &writeMu, identity, msg, sh, msgDialect)
				continue
			}
			go h.handleInvoke(ctx, conn, &writeMu, identity, msg, msgDialect)
		case "send":
			go h.handleSend(ctx, identity, msg)
		default:
			h.Logger.WarnContext(ctx, "wscompat: unknown message type", slog.String("type", msg.Type))
		}
	}
}

// invokeTimeout bounds every channel dispatch — matches rpc-client.ts's own
// INVOKE_TIMEOUT_MS (30s) so a hung downstream call fails with OUR error
// message before the client's own timeout fires with a generic, harder to
// diagnose "Request timed out: <channel>". Applied here (the transport
// layer) rather than per-handler in channels.go so every current AND
// future channel gets this for free, not just the ones wired so far.
const invokeTimeout = 25 * time.Second

// writeTimeout is the deadline for sending a single WS response frame back
// to the client. Kept short: by the time we reach a write, the dispatch is
// already done; a 5s window is generous for a single JSON frame over a
// local/LAN WebSocket connection. Deliberately independent of invokeTimeout
// so a timed-out or cancelled dispatch context does not silently drop the
// response (the original bug — BUG-001).
const writeTimeout = 5 * time.Second

func (h *Handler) handleInvoke(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, identity Identity, msg InboundMessage, msgDialect dialect) {
	dispatchCtx, dispatchCancel := context.WithTimeout(ctx, invokeTimeout)
	defer dispatchCancel()

	// Check the binary-stream path first (e.g. terminal.multiplex): its IO
	// is bound to ctx, NOT dispatchCtx — the binary sub-protocol must
	// outlive this one invoke's invokeTimeout deadline, same reasoning as
	// channels_terminal.go's attachContext for AttachPty streams.
	var result any
	var events <-chan PushEvent
	var isStreamChannel bool
	var err error
	if bh, ok := h.Registry.BinaryStreamHandlerFor(msg.Channel); ok {
		// ctx, NOT dispatchCtx: dispatchCtx is cancelled by this very
		// function's `defer dispatchCancel()` the moment handleInvoke
		// returns (right after writing the ack below) — a
		// BinaryStreamChannelHandler that watched dispatchCtx.Done() would
		// tear its whole sub-protocol down within microseconds of acking,
		// not when the connection actually closes. See BinaryStreamChannelHandler's
		// doc comment.
		result, err = bh(ctx, identity, msg.Args, h.binaryStreamIO(ctx, conn, writeMu))
	} else {
		// Check the stream-channel path next (e.g. terminal.create): its ack
		// AND its events channel both come out of one call — see
		// DispatchStreamChannel's doc comment. Everything else falls through
		// to the ordinary Dispatch path, exactly as before.
		result, events, isStreamChannel, err = h.Registry.DispatchStreamChannel(dispatchCtx, identity, msg.Channel, msg.Args)
		if !isStreamChannel {
			result, err = h.Registry.Dispatch(dispatchCtx, identity, msg.Channel, msg.Args)
		}
	}

	// Attempt to acquire writeMu; log if we have to wait significantly
	// (indicates concurrent timeout contention — see BUG-004 Cause B).
	lockStart := time.Now()
	writeMu.Lock()
	if waited := time.Since(lockStart); waited > 100*time.Millisecond {
		h.Logger.WarnContext(context.Background(), "wscompat: writeMu contention detected",
			slog.String("channel", msg.Channel),
			slog.Duration("lock_wait", waited))
	}

	// Use a fresh context for the write so a cancelled or timed-out
	// dispatchCtx does not silently drop the error or result frame.
	// context.Background() is intentional: the write must succeed even if
	// the parent HTTP request context has been cancelled (e.g. proxy
	// timeout, client navigation) — the WS connection itself is still open.
	writeCtx, writeCancel := context.WithTimeout(context.Background(), writeTimeout)

	if err != nil {
		_ = writeDialectError(writeCtx, conn, msgDialect, msg.ID, err)
		writeCancel()
		writeMu.Unlock()
		return
	}
	_ = writeDialectResult(writeCtx, conn, msgDialect, msg.ID, result)
	writeCancel()
	writeMu.Unlock()

	// Start piping push events only AFTER the ack write above — mirrors
	// handleSubscribe's own "ack first" ordering, so a push frame can never
	// arrive before the client has seen the ack (e.g. the ptyId) it needs to
	// associate that push with. Uses ctx (the connection's own lifetime), NOT
	// dispatchCtx — dispatchCtx dies with invokeTimeout, but the push
	// subscription must outlive this one invoke.
	if isStreamChannel && err == nil && events != nil {
		go pipePushForDialect(ctx, conn, writeMu, events, msgDialect, msg.ID)
	}
}

// binaryStreamIO builds the BinaryStreamIO a BinaryStreamChannelHandler uses
// to speak the binary sub-protocol on conn. SendBinary shares writeMu with
// every other write path on this connection (handleInvoke's own
// wsjson.Write, pipePush) — coder/websocket forbids concurrent writers on
// one connection, the same reason every other write in this package already
// serializes through writeMu. ctx is the connection-lifetime context (see
// handleInvoke's call site for why it is NOT dispatchCtx).
func (h *Handler) binaryStreamIO(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex) BinaryStreamIO {
	router := binaryStreamRouterFromContext(ctx)
	return BinaryStreamIO{
		SendBinary: func(frame []byte) bool {
			writeMu.Lock()
			defer writeMu.Unlock()
			return conn.Write(ctx, websocket.MessageBinary, frame) == nil
		},
		RegisterFrameHandler: func(streamID uint32, hnd BinaryFrameHandler) func() {
			if router == nil {
				return func() {}
			}
			return router.register(streamID, hnd)
		},
	}
}

// handleSubscribe opens a StreamHandler's subscription, acks the subscribe
// call itself with an ordinary ResultMessage (so the frontend's subscribe()
// promise resolves), then pipes events until the connection closes. ctx is
// NOT wrapped in a shorter timeout the way handleInvoke wraps dispatchCtx:
// a StreamHandler (e.g. registerNotificationStreamChannel) captures ctx for
// its own background forwarding goroutine, which must keep running for the
// whole connection's lifetime, not just the moment sh() is called — wrapping
// it in invokeTimeout would cancel that goroutine's context the instant
// Open() returns, killing the subscription before its first event.
//
// Both the initial ack AND every follow-up push event are dialect-aware
// (BUG-005 Phase 2, specs/backend-go/bugs/api-v1/solutions/SOL-005): a
// session-client caller of a subscribe-shaped channel (e.g.
// notifications.subscribe) gets a well-formed ack, Streaming:true updates
// keyed by ITS OWN request id (never ev.Channel — WebSessionClient has no
// channel-keyed push concept, see SessionClientResultMessage's doc comment),
// and a final {"type":"end"} frame when the subscription's event channel
// closes so its onClose callback fires — see pipePushForDialect
// (push_bridge.go).
func (h *Handler) handleSubscribe(ctx context.Context, conn *websocket.Conn, writeMu *sync.Mutex, identity Identity, msg InboundMessage, sh StreamHandler, msgDialect dialect) {
	events, err := sh(ctx, identity, msg.Args)

	writeMu.Lock()
	if err != nil {
		_ = writeDialectError(ctx, conn, msgDialect, msg.ID, err)
		writeMu.Unlock()
		return
	}
	_ = writeDialectResult(ctx, conn, msgDialect, msg.ID, nil)
	writeMu.Unlock()

	pipePushForDialect(ctx, conn, writeMu, events, msgDialect, msg.ID)
}

// handleSend dispatches a fire-and-forget "send" message the same way as
// "invoke", but never writes a response — matching rpc-client.ts's send(),
// which doesn't wait for one. Errors are logged, not surfaced to the
// client, since there's no request ID to correlate a response to.
//
// Not dialect-aware, deliberately: WebSessionClient's call()/subscribe()
// (web-session-client.ts) always waits for a response — there is no
// fire-and-forget send() on that client, so normalizeInboundMessage
// (session_dialect.go) never produces msg.Type == "send" for the
// session-client dialect, and this function only ever sees native "send"
// messages.

func (h *Handler) handleSend(ctx context.Context, identity Identity, msg InboundMessage) {
	dispatchCtx, cancel := context.WithTimeout(ctx, invokeTimeout)
	defer cancel()

	var args []json.RawMessage
	if len(msg.Data) > 0 {
		args = []json.RawMessage{msg.Data}
	}
	if _, err := h.Registry.Dispatch(dispatchCtx, identity, msg.Channel, args); err != nil {
		// Log with background ctx so the log entry is not dropped if the
		// HTTP request ctx was cancelled before the dispatch finished.
		h.Logger.WarnContext(context.Background(), "wscompat: send channel failed",
			slog.String("channel", msg.Channel), slog.Any("error", err))
	}
}
