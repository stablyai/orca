// provision_stream_registry.go — the ephemeralVm.provision/cancelProvision
// side of TASK-BE-EVM-005, mirroring channels_terminal.go's
// terminalStreamEntry/terminalStreamRegistry pattern exactly. One instance
// PER WEBSOCKET CONNECTION (wired via provisionStreamsContext from
// Handler.ServeHTTP, same as terminalStreamsContext), keyed by a
// server-minted provisionId — NOT runtimeId, because the frontend's
// cancelRuntimeEphemeralVmProvision correlates purely by the provisionId the
// provision ack returned (runtime-ephemeral-vm-client.ts:294-303), and a
// registry shared across connections would let one connection's
// cancelProvision reach another connection's stream if ids ever collided
// (same reasoning terminalStreamRegistry's own package doc comment gives for
// pty_id).
package wscompat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

// provisionStreamEntry is one live StreamVmProvision stream.
type provisionStreamEntry struct {
	stream infrafleetv1.InfraFleetService_StreamVmProvisionClient
	cancel context.CancelFunc
}

// provisionStreamRegistry maps provisionId -> its live StreamVmProvision
// stream, scoped to ONE WebSocket connection — see this file's package doc
// comment.
type provisionStreamRegistry struct {
	mu      sync.Mutex
	streams map[string]*provisionStreamEntry
}

func newProvisionStreamRegistry() *provisionStreamRegistry {
	return &provisionStreamRegistry{streams: make(map[string]*provisionStreamEntry)}
}

func (r *provisionStreamRegistry) put(provisionID string, entry *provisionStreamEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.streams[provisionID] = entry
}

func (r *provisionStreamRegistry) get(provisionID string) (*provisionStreamEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.streams[provisionID]
	return e, ok
}

// remove deletes and returns provisionID's entry, if any —
// drainVmProvisionOutput's own cleanup once its stream ends (see that
// function's doc comment in channels_ephemeral_vm.go for why this does NOT
// rely on cancelProvision being called to happen).
func (r *provisionStreamRegistry) remove(provisionID string) (*provisionStreamEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.streams[provisionID]
	delete(r.streams, provisionID)
	return e, ok
}

// provisionStreamsCtxKey is the context key provisionStreamsContext/
// provisionStreamsFromContext use to thread one connection's
// provisionStreamRegistry through ephemeralVm.provision/cancelProvision on
// that connection, without a package-level shared instance — mirrors
// terminalStreamsCtxKey exactly.
type provisionStreamsCtxKey struct{}

// provisionStreamsContext attaches streams as ctx's per-connection provision
// stream registry. Called once per WebSocket connection, from
// Handler.ServeHTTP (handler.go), before that connection's read/dispatch
// loop starts — same call site terminalStreamsContext/
// terminalJSONSubscribeContext/binaryStreamRouterContext already chain into.
func provisionStreamsContext(ctx context.Context, streams *provisionStreamRegistry) context.Context {
	return context.WithValue(ctx, provisionStreamsCtxKey{}, streams)
}

// provisionStreamsFromContext resolves the calling connection's
// provisionStreamRegistry, or nil if ctx was never wrapped by
// provisionStreamsContext (a wiring bug — every real request path wraps it
// in ServeHTTP; only a test that dispatches directly without doing so would
// see nil).
func provisionStreamsFromContext(ctx context.Context) *provisionStreamRegistry {
	streams, _ := ctx.Value(provisionStreamsCtxKey{}).(*provisionStreamRegistry)
	return streams
}

// errNoProvisionStreamRegistry is returned when ephemeralVm.provision can't
// find a per-connection provisionStreamRegistry on ctx — see
// provisionStreamsFromContext's doc comment.
var errNoProvisionStreamRegistry = fmt.Errorf("wscompat: no per-connection provision stream registry on context (internal wiring bug)")

// newProvisionID mints a fresh, server-side id for one ephemeralVm.provision
// call. Cannot reuse runtimeId as the correlation key (contrary to this
// task's original assumption before reading the real frontend contract):
// cancelRuntimeEphemeralVmProvision (frontend/src/renderer/src/runtime/
// runtime-ephemeral-vm-client.ts:294-303) sends only `{provisionId}` to
// ephemeralVm.cancelProvision, never runtimeId, and the environment/paired
// provisionRuntimeEphemeralVmWorkspace branch (same file, lines 208-230)
// never sends or generates a provisionId itself — it is purely whatever the
// server's ack response hands back. google/uuid is only an indirect go.mod
// dependency for api-gateway (no direct import anywhere in this service) —
// plain crypto/rand hex bytes avoid promoting it to a direct one for a
// single opaque id.
func newProvisionID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("wscompat: generating provision id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
