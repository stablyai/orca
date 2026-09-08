// file_watch_stream_registry.go — the files.watch/files.unwatch side of
// BACKLOG-003, mirroring provision_stream_registry.go's pattern exactly
// (which itself mirrors channels_terminal.go's terminalStreamEntry/
// terminalStreamRegistry). One instance PER WEBSOCKET CONNECTION (wired via
// fileWatchStreamsContext from Handler.ServeHTTP, same as
// terminalStreamsContext/provisionStreamsContext), keyed by a
// server-minted subscriptionId — NOT worktreeId, because
// unwatchSharedRuntimeFileWatch (frontend/src/renderer/src/runtime/
// runtime-file-client.ts) sends {subscriptionId}, the value this
// channel's own "ready" ack handed back, and a registry shared across
// connections would let one connection's files.unwatch reach another
// connection's stream if ids ever collided (same reasoning
// terminalStreamRegistry's own package doc comment gives for pty_id).
package wscompat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
)

// fileWatchStreamEntry is one live WatchWorktree stream — no sendMu/stream
// field like terminalStreamEntry needs: WatchWorktree is server-streaming
// only, there is nothing to Send after the initial request, so cancel is
// the only thing files.unwatch needs to reach.
type fileWatchStreamEntry struct {
	cancel context.CancelFunc
}

// fileWatchStreamRegistry maps subscriptionId -> its live WatchWorktree
// stream, scoped to ONE WebSocket connection — see this file's package doc
// comment.
type fileWatchStreamRegistry struct {
	mu      sync.Mutex
	streams map[string]*fileWatchStreamEntry
}

func newFileWatchStreamRegistry() *fileWatchStreamRegistry {
	return &fileWatchStreamRegistry{streams: make(map[string]*fileWatchStreamEntry)}
}

func (r *fileWatchStreamRegistry) put(subscriptionID string, entry *fileWatchStreamEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.streams[subscriptionID] = entry
}

func (r *fileWatchStreamRegistry) get(subscriptionID string) (*fileWatchStreamEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.streams[subscriptionID]
	return e, ok
}

// remove deletes and returns subscriptionID's entry, if any —
// drainFileWatchOutput's own cleanup once its stream ends (must not rely on
// files.unwatch ever being called — same reasoning
// provisionStreamRegistry.remove's doc comment gives).
func (r *fileWatchStreamRegistry) remove(subscriptionID string) (*fileWatchStreamEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.streams[subscriptionID]
	delete(r.streams, subscriptionID)
	return e, ok
}

// fileWatchStreamsCtxKey is the context key fileWatchStreamsContext/
// fileWatchStreamsFromContext use to thread one connection's
// fileWatchStreamRegistry through files.watch/files.unwatch on that
// connection, without a package-level shared instance — mirrors
// provisionStreamsCtxKey exactly.
type fileWatchStreamsCtxKey struct{}

// fileWatchStreamsContext attaches streams as ctx's per-connection
// file-watch stream registry. Called once per WebSocket connection, from
// Handler.ServeHTTP (handler.go), before that connection's read/dispatch
// loop starts — same call site terminalStreamsContext/provisionStreamsContext
// already chain into.
func fileWatchStreamsContext(ctx context.Context, streams *fileWatchStreamRegistry) context.Context {
	return context.WithValue(ctx, fileWatchStreamsCtxKey{}, streams)
}

// fileWatchStreamsFromContext resolves the calling connection's
// fileWatchStreamRegistry, or nil if ctx was never wrapped by
// fileWatchStreamsContext (a wiring bug — every real request path wraps it
// in ServeHTTP; only a test that dispatches directly without doing so would
// see nil).
func fileWatchStreamsFromContext(ctx context.Context) *fileWatchStreamRegistry {
	streams, _ := ctx.Value(fileWatchStreamsCtxKey{}).(*fileWatchStreamRegistry)
	return streams
}

// errNoFileWatchStreamRegistry is returned when files.watch can't find a
// per-connection fileWatchStreamRegistry on ctx — see
// fileWatchStreamsFromContext's doc comment.
var errNoFileWatchStreamRegistry = fmt.Errorf("wscompat: no per-connection file-watch stream registry on context (internal wiring bug)")

// newFileWatchID mints a fresh, server-side id for one files.watch
// subscription — same crypto/rand-hex convention newProvisionID uses (and
// the same reason: google/uuid is only an indirect go.mod dependency for
// api-gateway).
func newFileWatchID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("wscompat: generating file-watch subscription id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
