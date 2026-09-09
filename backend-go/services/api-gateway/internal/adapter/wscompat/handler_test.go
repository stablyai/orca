package wscompat

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/stablyai/orca-go/common/jwtauth"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"

	"github.com/go-jose/go-jose/v4/jwt"
)

// TestNotImplementedChannelReturnsErrorFast verifies that an unregistered
// channel returns an error immediately (< 500ms), not after the 30s frontend
// INVOKE_TIMEOUT_MS. Regression guard for BUG-001 + BUG-002.
func TestNotImplementedChannelReturnsErrorFast(t *testing.T) {
	reg := NewRegistry() // empty registry — every channel falls to notImplementedHandler

	start := time.Now()
	_, err := reg.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "crashReports.getLatestPending", nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want error for unregistered channel, got nil")
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("notImplementedHandler should be instant, took %s — possible context block", elapsed)
	}
}

// TestRegistryDispatch_UnregisteredChannelErrorContainsChannelName verifies
// that the notImplementedHandler's error message contains the channel name
// so the frontend (and logs) can identify which channel is missing.
func TestRegistryDispatch_UnregisteredChannelErrorContainsChannelName(t *testing.T) {
	reg := NewRegistry()

	_, err := reg.Dispatch(context.Background(), Identity{}, "rateLimits.get", nil)
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "rateLimits.get") {
		t.Errorf("error message should contain channel name 'rateLimits.get', got: %q", err.Error())
	}
}

// TestWriteTimeoutConstant_ShorterThanInvokeTimeout documents the required
// relationship between writeTimeout (SOL-001) and invokeTimeout. If someone
// accidentally sets writeTimeout >= invokeTimeout, the write would always
// race with the dispatch cancellation instead of running independently.
func TestWriteTimeoutConstant_ShorterThanInvokeTimeout(t *testing.T) {
	if writeTimeout >= invokeTimeout {
		t.Errorf("writeTimeout (%s) must be < invokeTimeout (%s); "+
			"writeTimeout is for the write-back step only, not the full dispatch",
			writeTimeout, invokeTimeout)
	}
}

// ── Push-bridge subscribe tests (TASK-016) ──────────────────────────────

var errSubscribeFailed = errors.New("subscribe failed")

func writeJSONFrame(ctx context.Context, conn *websocket.Conn, v any) error {
	return wsjson.Write(ctx, conn, v)
}

func readWireMessage(t *testing.T, ctx context.Context, conn *websocket.Conn) wireMessage {
	t.Helper()
	var msg wireMessage
	if err := wsjson.Read(ctx, conn, &msg); err != nil {
		t.Fatalf("reading frame: %v", err)
	}
	return msg
}

// fakeSessionValidator implements SessionValidator with a canned identity —
// every test connection in this file authenticates successfully.
type fakeSessionValidator struct {
	identity Identity
}

func (f fakeSessionValidator) ValidateCookie(_ context.Context, _ *http.Request) (Identity, error) {
	return f.identity, nil
}

func newTestHandlerServer(t *testing.T, registry *Registry) *httptest.Server {
	t.Helper()
	h := New(slog.Default(), fakeSessionValidator{identity: Identity{TenantID: "tenant-1", UserID: "user-1"}}, nil, registry)
	ts := httptest.NewServer(http.HandlerFunc(h.ServeHTTP))
	t.Cleanup(ts.Close)
	return ts
}

// wireMessage is a superset envelope covering every server->client frame
// shape (ResultMessage, ErrorMessage, PushMessage) so a test can read
// whatever comes next off the connection and branch on Type.
type wireMessage struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result"`
	Message string          `json:"message"`
	Channel string          `json:"channel"`
	Args    []any           `json:"args"`
}

func TestHandleSubscribe_AcksThenStreams(t *testing.T) {
	registry := NewRegistry()
	events := make(chan PushEvent, 2)
	registry.RegisterStream("test.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		return events, nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeJSONFrame(ctx, client, InboundMessage{ID: "sub-1", Type: "invoke", Channel: "test.subscribe"}); err != nil {
		t.Fatalf("writing subscribe invoke: %v", err)
	}

	// 1. the subscribe ack — an ordinary ResultMessage with a nil result.
	ack := readWireMessage(t, ctx, client)
	if ack.Type != "result" || ack.ID != "sub-1" {
		t.Fatalf("first frame = %+v, want the subscribe ack (type=result, id=sub-1)", ack)
	}

	// 2. two push frames, in order.
	events <- PushEvent{Channel: "test.event", Args: []any{"first"}}
	events <- PushEvent{Channel: "test.event", Args: []any{"second"}}

	for i, want := range []string{"first", "second"} {
		got := readWireMessage(t, ctx, client)
		if got.Type != "push" || got.Channel != "test.event" {
			t.Fatalf("push frame %d = %+v, want type=push channel=test.event", i, got)
		}
		if len(got.Args) != 1 || got.Args[0] != want {
			t.Fatalf("push frame %d args = %v, want [%q]", i, got.Args, want)
		}
	}
}

func TestHandleSubscribe_SubscriberErrorSurfacesAsErrorMessage(t *testing.T) {
	registry := NewRegistry()
	registry.RegisterStream("test.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		return nil, errSubscribeFailed
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeJSONFrame(ctx, client, InboundMessage{ID: "sub-1", Type: "invoke", Channel: "test.subscribe"}); err != nil {
		t.Fatalf("writing subscribe invoke: %v", err)
	}

	got := readWireMessage(t, ctx, client)
	if got.Type != "error" || got.ID != "sub-1" {
		t.Fatalf("got %+v, want an ErrorMessage for id=sub-1", got)
	}
}

// TestHandleSubscribe_InterleavesWithConcurrentInvoke fires one subscribe
// and one concurrent ordinary invoke on the SAME connection, and asserts
// every frame decodes cleanly with the right id/channel — a regression
// guard on writeMu being shared correctly between handleInvoke,
// handleSubscribe, and pipePush (handler.go/push_bridge.go). Frame
// corruption from an unsynchronized concurrent write would show up here as
// a JSON decode failure or a frame with a wrong/garbled id.
func TestHandleSubscribe_InterleavesWithConcurrentInvoke(t *testing.T) {
	registry := NewRegistry()
	events := make(chan PushEvent, 1)
	registry.RegisterStream("test.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		return events, nil
	})
	registry.Register("test.invoke", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return "invoke-result", nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeJSONFrame(ctx, client, InboundMessage{ID: "sub-1", Type: "invoke", Channel: "test.subscribe"}); err != nil {
		t.Fatalf("writing subscribe invoke: %v", err)
	}
	if err := writeJSONFrame(ctx, client, InboundMessage{ID: "call-1", Type: "invoke", Channel: "test.invoke"}); err != nil {
		t.Fatalf("writing ordinary invoke: %v", err)
	}
	events <- PushEvent{Channel: "test.event", Args: []any{"payload"}}

	seenSubAck, seenInvokeResult, seenPush := false, false, false
	for i := 0; i < 3; i++ {
		got := readWireMessage(t, ctx, client)
		switch {
		case got.Type == "result" && got.ID == "sub-1":
			seenSubAck = true
		case got.Type == "result" && got.ID == "call-1":
			seenInvokeResult = true
			var result string
			if err := json.Unmarshal(got.Result, &result); err != nil || result != "invoke-result" {
				t.Fatalf("call-1 result = %s (err=%v), want %q", got.Result, err, "invoke-result")
			}
		case got.Type == "push" && got.Channel == "test.event":
			seenPush = true
		default:
			t.Fatalf("unexpected/corrupted frame %d: %+v", i, got)
		}
	}
	if !seenSubAck || !seenInvokeResult || !seenPush {
		t.Fatalf("missing frame(s): subAck=%v invokeResult=%v push=%v", seenSubAck, seenInvokeResult, seenPush)
	}
}

// ── Session-client dialect tests (BUG-005 / SOL-005) ────────────────────
//
// WebSessionClient (frontend/src/renderer/src/web/web-session-client.ts)
// sends {"id","authToken","method","params"} with NO "type" key — writeRaw
// below sends exactly that shape as raw bytes, since InboundMessage's Type
// field lacks `omitempty` and would always marshal a `"type":""` key,
// which is not what the real client sends.

func writeRaw(ctx context.Context, conn *websocket.Conn, raw string) error {
	return conn.Write(ctx, websocket.MessageText, []byte(raw))
}

// sessionClientWireMessage decodes a RuntimeRpcResponse-shaped frame
// (frontend/src/shared/runtime-rpc-envelope.ts) — the wire shape
// session-client-dialect responses must match byte-for-byte.
type sessionClientWireMessage struct {
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Meta struct {
		RuntimeID *string `json:"runtimeId"`
	} `json:"_meta"`
	Streaming bool `json:"streaming"`
}

// TestNativeInvokeDialect_UnchangedByDialectBridge is a regression guard:
// an ordinary {"type":"invoke",...} message must still get today's
// ResultMessage shape ({"type":"result",...}, no "_meta") after wiring in
// normalizeInboundMessage/writeDialectResult.
func TestNativeInvokeDialect_UnchangedByDialectBridge(t *testing.T) {
	registry := NewRegistry()
	registry.Register("test.echo", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return map[string]string{"hello": "world"}, nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeJSONFrame(ctx, client, InboundMessage{ID: "native-1", Type: "invoke", Channel: "test.echo"}); err != nil {
		t.Fatalf("writing native invoke: %v", err)
	}

	raw := readRawFrame(t, ctx, client)
	if !strings.Contains(raw, `"type":"result"`) {
		t.Fatalf("native invoke response = %s, want a ResultMessage (type=result)", raw)
	}
	if strings.Contains(raw, "_meta") {
		t.Fatalf("native invoke response = %s, must NOT contain _meta (that's the session-client dialect only)", raw)
	}
}

// TestSessionClientDialect_RoundTripsThroughRegisteredChannel verifies a
// WebSessionClient-shaped {"id","authToken","method","params"} message (no
// "type" key) is bridged onto Registry.Dispatch and comes back as
// {"id","ok":true,"result","_meta":{"runtimeId":"backend-go"}} — the exact
// RuntimeRpcSuccess shape frontend/'s WebSessionClient expects.
func TestSessionClientDialect_RoundTripsThroughRegisteredChannel(t *testing.T) {
	registry := NewRegistry()
	registry.Register("git.status", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		var params map[string]string
		if err := json.Unmarshal(args[0], &params); err != nil {
			return nil, err
		}
		return map[string]string{"repoPath": params["repoPath"], "branch": "main"}, nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeRaw(ctx, client, `{"id":"web-session-rpc-1","authToken":"cookie-auth","method":"git.status","params":{"repoPath":"/repo"}}`); err != nil {
		t.Fatalf("writing session-client invoke: %v", err)
	}

	got := readSessionClientWireMessage(t, ctx, client)
	if got.ID != "web-session-rpc-1" {
		t.Fatalf("id = %q, want %q", got.ID, "web-session-rpc-1")
	}
	if !got.OK {
		t.Fatalf("ok = false, want true (error=%+v)", got.Error)
	}
	if got.Meta.RuntimeID == nil || *got.Meta.RuntimeID != "backend-go" {
		t.Fatalf("_meta.runtimeId = %v, want \"backend-go\"", got.Meta.RuntimeID)
	}
	var result map[string]string
	if err := json.Unmarshal(got.Result, &result); err != nil {
		t.Fatalf("decoding result: %v", err)
	}
	if result["repoPath"] != "/repo" || result["branch"] != "main" {
		t.Fatalf("result = %+v, want repoPath=/repo branch=main", result)
	}
}

// TestSessionClientDialect_NoParams_ReachesHandlerWithEmptyArgs is the
// direct regression test for BUG-006 (specs/backend-go/bugs/missing-v2/):
// a WebSessionClient call with no "params" key at all (the natural shape
// for any method whose real contract is params: null) must reach a
// strict decodeArg-based handler with a decodable args[0], not fail with
// "missing arg[0]" before the handler is ever invoked.
func TestSessionClientDialect_NoParams_ReachesHandlerWithEmptyArgs(t *testing.T) {
	registry := NewRegistry()
	var handlerCalled bool
	registry.Register("repo.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		handlerCalled = true
		type listArgs struct {
			ProjectID string `json:"projectId"`
		}
		in, err := decodeArg[listArgs](args, 0)
		if err != nil {
			return nil, fmt.Errorf("decodeArg: %w", err) // this is exactly BUG-006's failure if the fix is missing
		}
		return map[string]string{"projectId": in.ProjectID}, nil // empty string is the correct zero value
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// No "params" key at all — the exact shape that broke before this fix.
	if err := writeRaw(ctx, client, `{"id":"web-session-rpc-1","authToken":"cookie-auth","method":"repo.list"}`); err != nil {
		t.Fatalf("writing session-client invoke: %v", err)
	}

	got := readSessionClientWireMessage(t, ctx, client)
	if !handlerCalled {
		t.Fatal("expected the repo.list handler to be invoked — request never reached it")
	}
	if !got.OK {
		t.Fatalf("ok = false, want true (error=%+v) — this is BUG-006's exact failure if unfixed", got.Error)
	}
}

// TestSessionClientDialect_ExplicitNullParams_SameAsOmitted covers the
// second BUG-006 trigger shape: an explicit "params":null behaves
// identically to an omitted params key.
func TestSessionClientDialect_ExplicitNullParams_SameAsOmitted(t *testing.T) {
	registry := NewRegistry()
	registry.Register("repo.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			ProjectID string `json:"projectId"`
		}
		if _, err := decodeArg[listArgs](args, 0); err != nil {
			return nil, fmt.Errorf("decodeArg: %w", err)
		}
		return map[string]bool{"ok": true}, nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeRaw(ctx, client, `{"id":"web-session-rpc-1","authToken":"cookie-auth","method":"repo.list","params":null}`); err != nil {
		t.Fatalf("writing session-client invoke: %v", err)
	}

	got := readSessionClientWireMessage(t, ctx, client)
	if !got.OK {
		t.Fatalf("ok = false, want true (error=%+v)", got.Error)
	}
}

func TestNormalizeInboundMessage_NoParams_PopulatesEmptyObjectArg(t *testing.T) {
	d, normalized := normalizeInboundMessage(InboundMessage{ID: "x", Method: "repo.list"})
	if d != dialectSessionClient {
		t.Fatalf("expected dialectSessionClient, got %v", d)
	}
	if len(normalized.Args) != 1 || string(normalized.Args[0]) != "{}" {
		t.Fatalf("expected Args[0] = {}, got %v", normalized.Args)
	}
}

func TestNormalizeInboundMessage_RealParams_PassedThroughUnchanged(t *testing.T) {
	d, normalized := normalizeInboundMessage(InboundMessage{ID: "x", Method: "repo.list", Params: json.RawMessage(`{"projectId":"p1"}`)})
	if d != dialectSessionClient {
		t.Fatalf("expected dialectSessionClient, got %v", d)
	}
	if len(normalized.Args) != 1 || string(normalized.Args[0]) != `{"projectId":"p1"}` {
		t.Fatalf("expected real params passed through unchanged, got %v", normalized.Args)
	}
}

// TestSessionClientDialect_ErrorPathReturnsOkFalse verifies a failed
// dispatch comes back as {"id","ok":false,"error":{"code","message"},
// "_meta":{"runtimeId":null}} — RuntimeRpcFailure's shape.
func TestSessionClientDialect_ErrorPathReturnsOkFalse(t *testing.T) {
	registry := NewRegistry() // "git.status" unregistered -> notImplementedHandler

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeRaw(ctx, client, `{"id":"web-session-rpc-2","authToken":"cookie-auth","method":"git.status","params":{}}`); err != nil {
		t.Fatalf("writing session-client invoke: %v", err)
	}

	got := readSessionClientWireMessage(t, ctx, client)
	if got.ID != "web-session-rpc-2" {
		t.Fatalf("id = %q, want %q", got.ID, "web-session-rpc-2")
	}
	if got.OK {
		t.Fatal("ok = true, want false for an unregistered channel")
	}
	if got.Error == nil || got.Error.Code == "" || got.Error.Message == "" {
		t.Fatalf("error = %+v, want a populated {code,message}", got.Error)
	}
	if !strings.Contains(got.Error.Message, "git.status") {
		t.Errorf("error.message = %q, want it to name the channel", got.Error.Message)
	}
	if got.Meta.RuntimeID != nil {
		t.Errorf("_meta.runtimeId = %v, want nil on failure", *got.Meta.RuntimeID)
	}
}

// TestGarbageMessage_NeitherTypeNorMethod_HandledGracefully verifies a
// message with neither "type" nor "method" is still handled the same way it
// was before this dialect bridge existed: logged, connection stays open, no
// panic, no response written for that specific message.
func TestGarbageMessage_NeitherTypeNorMethod_HandledGracefully(t *testing.T) {
	registry := NewRegistry()
	registry.Register("test.echo", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return "ok", nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeRaw(ctx, client, `{"id":"garbage-1","foo":"bar"}`); err != nil {
		t.Fatalf("writing garbage message: %v", err)
	}

	// The connection must survive the garbage message: a subsequent
	// ordinary invoke on the SAME connection must still get a response.
	if err := writeJSONFrame(ctx, client, InboundMessage{ID: "after-garbage", Type: "invoke", Channel: "test.echo"}); err != nil {
		t.Fatalf("writing invoke after garbage message: %v", err)
	}
	ack := readWireMessage(t, ctx, client)
	if ack.Type != "result" || ack.ID != "after-garbage" {
		t.Fatalf("post-garbage invoke response = %+v, want type=result id=after-garbage", ack)
	}
}

// TestSessionClientDialect_SubscribeChannelStreamsAndEnds verifies Phase 2
// (see handleSubscribe/pipePushForDialect's doc comments): a session-client
// caller of a StreamHandler-registered channel gets a dialect-correct ack,
// every follow-up event as a Streaming:true frame correlated by ITS OWN
// request id (never ev.Channel — WebSessionClient has no channel-keyed push
// concept), and a final {"type":"end"} frame once the event channel closes.
func TestSessionClientDialect_SubscribeChannelStreamsAndEnds(t *testing.T) {
	registry := NewRegistry()
	events := make(chan PushEvent, 1)
	registry.RegisterStream("test.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		return events, nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeRaw(ctx, client, `{"id":"web-session-rpc-3","authToken":"cookie-auth","method":"test.subscribe","params":{}}`); err != nil {
		t.Fatalf("writing session-client subscribe: %v", err)
	}

	ack := readSessionClientWireMessage(t, ctx, client)
	if ack.ID != "web-session-rpc-3" || !ack.OK || ack.Streaming {
		t.Fatalf("ack = %+v, want ok=true id=web-session-rpc-3 streaming=false", ack)
	}

	// A single-arg PushEvent unwraps to its bare value (pushEventResult),
	// carries the SAME request id (never ev.Channel), and is marked
	// Streaming so WebSessionClient's isSubscriptionResponse routes it to
	// the subscriber instead of silently dropping it (see
	// SessionClientResultMessage's doc comment).
	events <- PushEvent{Channel: "test.event", Args: []any{"payload"}}
	update := readSessionClientWireMessage(t, ctx, client)
	if update.ID != "web-session-rpc-3" || !update.OK || !update.Streaming {
		t.Fatalf("update = %+v, want ok=true id=web-session-rpc-3 streaming=true", update)
	}
	if got := string(update.Result); got != `"payload"` {
		t.Fatalf("update.Result = %s, want unwrapped bare value %q", got, `"payload"`)
	}

	// Closing the event channel must produce exactly one final {"type":"end"}
	// frame (Streaming omitted/false — isEndResult keys off Result alone) so
	// WebSessionClient's onClose fires and it stops tracking this request id.
	close(events)
	end := readSessionClientWireMessage(t, ctx, client)
	if end.ID != "web-session-rpc-3" || !end.OK || end.Streaming {
		t.Fatalf("end = %+v, want ok=true id=web-session-rpc-3 streaming=false", end)
	}
	if got := string(end.Result); got != `{"type":"end"}` {
		t.Fatalf("end.Result = %s, want {\"type\":\"end\"}", got)
	}
}

func readRawFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) string {
	t.Helper()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("reading raw frame: %v", err)
	}
	return string(data)
}

func readSessionClientWireMessage(t *testing.T, ctx context.Context, conn *websocket.Conn) sessionClientWireMessage {
	t.Helper()
	var msg sessionClientWireMessage
	if err := wsjson.Read(ctx, conn, &msg); err != nil {
		t.Fatalf("reading session-client frame: %v", err)
	}
	return msg
}

// TestSessionClientDialect_StreamChannelAckAndPushBothBridge covers
// handleInvoke's OTHER push path (registry.go's StreamChannelHandler, e.g.
// terminal.create — an ack value AND an events channel from one call,
// distinct from handleSubscribe's pure-subscribe StreamHandler path already
// covered above) — both the ack and its follow-up push must go through the
// same dialect bridge.
func TestSessionClientDialect_StreamChannelAckAndPushBothBridge(t *testing.T) {
	registry := NewRegistry()
	events := make(chan PushEvent, 1)
	registry.RegisterStreamChannel("test.streamChannel", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
		return map[string]string{"sessionId": "abc"}, events, nil
	})

	ts := newTestHandlerServer(t, registry)
	client := dialTestClient(t, ts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := writeRaw(ctx, client, `{"id":"web-session-rpc-4","authToken":"cookie-auth","method":"test.streamChannel","params":{}}`); err != nil {
		t.Fatalf("writing session-client invoke: %v", err)
	}

	ack := readSessionClientWireMessage(t, ctx, client)
	if ack.ID != "web-session-rpc-4" || !ack.OK || ack.Streaming {
		t.Fatalf("ack = %+v, want ok=true id=web-session-rpc-4 streaming=false", ack)
	}
	if got := string(ack.Result); got != `{"sessionId":"abc"}` {
		t.Fatalf("ack.Result = %s, want the StreamChannelHandler's ack value verbatim", got)
	}

	events <- PushEvent{Channel: "test.streamEvent", Args: []any{"chunk"}}
	update := readSessionClientWireMessage(t, ctx, client)
	if update.ID != "web-session-rpc-4" || !update.OK || !update.Streaming {
		t.Fatalf("update = %+v, want ok=true id=web-session-rpc-4 streaming=true", update)
	}
	if got := string(update.Result); got != `"chunk"` {
		t.Fatalf("update.Result = %s, want unwrapped bare value %q", got, `"chunk"`)
	}
}

// fakeCookieSessionValidator implements SessionValidator with a
// configurable failure, for exercising resolveIdentity's cookie-vs-bearer
// fallback order (mirrors wsbridge's fakeCookieValidator, copied rather than
// imported cross-package per this package's own test convention).
type fakeCookieSessionValidator struct {
	identity Identity
	err      error
	calls    int
}

func (f *fakeCookieSessionValidator) ValidateCookie(_ context.Context, _ *http.Request) (Identity, error) {
	f.calls++
	if f.err != nil {
		return Identity{}, f.err
	}
	return f.identity, nil
}

// fakeJWKSClient / newBearerAuthValidator, same pattern as
// wsbridge/handler_test.go's identically named helpers (copied, not
// cross-package imported, per that file's own doc comment convention).
type fakeJWKSClient struct {
	kid string
	key any
}

func (f *fakeJWKSClient) PublicKey(_ context.Context, kid string) (any, error) {
	if kid != f.kid {
		return nil, fmt.Errorf("fakeJWKSClient: no key for kid %q", kid)
	}
	return f.key, nil
}

func newBearerAuthValidator(t *testing.T) (*usecase.AuthValidator, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating test RSA key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshaling public key: %v", err)
	}
	pemBlock := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})

	sign := func(_ context.Context, _ string, input []byte) (string, error) {
		digest := sha256.Sum256(input)
		sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
		if err != nil {
			return "", err
		}
		return "vault:v1:" + base64.StdEncoding.EncodeToString(sig), nil
	}
	pubKey := func(_ context.Context, _ string) (map[int]string, int, error) {
		return map[int]string{1: string(pemBlock)}, 1, nil
	}

	signer := jwtauth.NewTransitSigner("jwt-signing", sign, pubKey)
	token, err := jwtauth.Sign(context.Background(), signer, jwtauth.Claims{
		Claims: jwt.Claims{
			Issuer:   jwtauth.Issuer,
			Subject:  "user-bearer",
			IssuedAt: jwt.NewNumericDate(time.Now()),
			Expiry:   jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		TenantID: "tenant-bearer",
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	jwks, err := signer.PublicJWKS(context.Background())
	if err != nil {
		t.Fatalf("PublicJWKS: %v", err)
	}

	v := usecase.NewAuthValidator(&fakeJWKSClient{kid: jwks.Keys[0].KeyID, key: jwks.Keys[0].Key})
	return v, token
}

func TestHandler_ResolveIdentity_PrefersCookieOverBearerJWT(t *testing.T) {
	auth, token := newBearerAuthValidator(t)
	cookie := &fakeCookieSessionValidator{identity: Identity{TenantID: "tenant-cookie", UserID: "user-cookie"}}
	h := &Handler{Auth: cookie, BearerAuth: auth}

	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	id, err := h.resolveIdentity(r)
	if err != nil {
		t.Fatalf("resolveIdentity: %v", err)
	}
	if id.TenantID != "tenant-cookie" || id.UserID != "user-cookie" {
		t.Fatalf("got Identity{%q,%q}, want cookie-resolved identity", id.TenantID, id.UserID)
	}
	if cookie.calls != 1 {
		t.Fatalf("cookie validator calls = %d, want 1", cookie.calls)
	}
}

func TestHandler_ResolveIdentity_FallsBackToBearerJWTWhenCookieFails(t *testing.T) {
	auth, token := newBearerAuthValidator(t)
	cookie := &fakeCookieSessionValidator{err: fmt.Errorf("no session cookie present")}
	h := &Handler{Auth: cookie, BearerAuth: auth}

	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	id, err := h.resolveIdentity(r)
	if err != nil {
		t.Fatalf("resolveIdentity: %v", err)
	}
	if id.TenantID != "tenant-bearer" || id.UserID != "user-bearer" {
		t.Fatalf("got Identity{%q,%q}, want bearer-resolved identity", id.TenantID, id.UserID)
	}
	if cookie.calls != 1 {
		t.Fatalf("cookie validator calls = %d, want 1", cookie.calls)
	}
}

// TestHandler_ResolveIdentity_BearerAuthNilFallsThroughToError differs from
// wsbridge's equivalent test set: there, Cookie is the nil-tolerant field;
// here BearerAuth is nil-tolerant instead (Auth is required, never nil) —
// this covers that BearerAuth == nil case specifically, which has no
// wsbridge analog.
func TestHandler_ResolveIdentity_BearerAuthNilFallsThroughToError(t *testing.T) {
	cookie := &fakeCookieSessionValidator{err: fmt.Errorf("no session cookie present")}
	h := &Handler{Auth: cookie, BearerAuth: nil}

	r := httptest.NewRequest(http.MethodGet, "/ws", nil)

	if _, err := h.resolveIdentity(r); err == nil {
		t.Fatal("expected an error when cookie fails and BearerAuth is nil")
	}
	if cookie.calls != 1 {
		t.Fatalf("cookie validator calls = %d, want 1", cookie.calls)
	}
}

func TestHandler_ResolveIdentity_BothFail(t *testing.T) {
	auth, _ := newBearerAuthValidator(t)
	cookie := &fakeCookieSessionValidator{err: fmt.Errorf("no session cookie present")}
	h := &Handler{Auth: cookie, BearerAuth: auth}

	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	// No Authorization header and no cookie present at all.

	if _, err := h.resolveIdentity(r); err == nil {
		t.Fatal("expected an error when neither cookie nor bearer JWT resolve")
	}
}
