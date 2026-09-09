package devserveragent

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"
)

// vmProvisionTestDevServer builds the one devServer every test in this file
// dials — relay-websocket mode, mirroring testEmulatorDevServer's usecase
// package equivalent, just local to this package's tests.
func vmProvisionTestDevServer(t *testing.T, host string) domain.DevServer {
	t.Helper()
	ds, err := domain.NewDevServer("ds-vmprov", "tenant-1", host, domain.ConnectionModeRelayWebSocket, "")
	if err != nil {
		t.Fatalf("NewDevServer: %v", err)
	}
	return ds
}

func drainVmProvisionEvents(t *testing.T, ch <-chan usecase.VmProvisionEvent, timeout time.Duration) []usecase.VmProvisionEvent {
	t.Helper()
	var got []usecase.VmProvisionEvent
	deadline := time.After(timeout)
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return got
			}
			got = append(got, e)
		case <-deadline:
			t.Fatalf("timed out waiting for StreamVmProvision to close its channel; events so far: %+v", got)
		}
	}
}

// TestStreamVmProvision_DemuxesStdoutStderrChunks covers the
// stream.started (swallowed) → stream.chunk(stdout/stderr) → stream.end
// demux, mirroring handleVmProvision's real onStdout/onStderr callback
// shape (agent-ephemeral-vm-handler.ts).
func TestStreamVmProvision_DemuxesStdoutStderrChunks(t *testing.T) {
	agent := &fakeAgent{t: t, requireToken: fakeAgentToken, vmProvisionFrames: []map[string]any{
		{"type": "stream.started"},
		{"type": "stream.chunk", "line": "cloning repo..."},
		{"type": "stream.chunk", "line": "warning: slow network", "source": "stderr"},
		{"type": "stream.end", "exitCode": 0, "provisionResult": map[string]any{
			"ok": true,
			"result": map[string]any{
				"schemaVersion": 1, "pairingCode": "abc-123", "projectRoot": "/vm/repo",
			},
		}},
	}}
	host, port := startFakeAgent(t, agent)
	client := New(testConfig(port, fakeAgentToken), slog.Default())
	t.Cleanup(client.Close)

	events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{
		RepoPath: "/repo", Command: "create.sh", RecipeID: "recipe-1", RuntimeID: "rt-1",
	})
	if err != nil {
		t.Fatalf("StreamVmProvision: %v", err)
	}
	defer unsubscribe()

	got := drainVmProvisionEvents(t, events, 5*time.Second)
	if len(got) != 3 {
		t.Fatalf("expected 3 events (stdout, stderr, result), got %d: %+v", len(got), got)
	}
	if got[0].Type != "stdout" || got[0].Chunk != "cloning repo..." {
		t.Errorf("event[0] = %+v, want stdout chunk", got[0])
	}
	if got[1].Type != "stderr" || got[1].Chunk != "warning: slow network" {
		t.Errorf("event[1] = %+v, want stderr chunk", got[1])
	}
	if got[2].Type != "result" {
		t.Errorf("event[2].Type = %q, want result", got[2].Type)
	}

	if params := agent.lastParams(t, "vm.provision"); params["repoPath"] != "/repo" || params["command"] != "create.sh" ||
		params["recipeId"] != "recipe-1" || params["runtimeId"] != "rt-1" {
		t.Errorf("unexpected vm.provision params sent: %+v", params)
	}
}

// TestStreamVmProvision_EmitsResultEventOnStreamEnd covers both recipe
// result shapes: the legacy (pairingCode/projectRoot at top level) and the
// new explicit connection shape (ssh target), per
// ephemeral-vm-recipes.ts's EphemeralVmRecipeResult union.
func TestStreamVmProvision_EmitsResultEventOnStreamEnd(t *testing.T) {
	t.Run("legacy orca-server shape", func(t *testing.T) {
		agent := &fakeAgent{t: t, requireToken: fakeAgentToken, vmProvisionFrames: []map[string]any{
			{"type": "stream.started"},
			{"type": "stream.end", "exitCode": 0, "provisionResult": map[string]any{
				"ok": true,
				"result": map[string]any{
					"schemaVersion": 1, "pairingCode": "pair-xyz", "projectRoot": "/vm/proj",
				},
			}},
		}}
		host, port := startFakeAgent(t, agent)
		client := New(testConfig(port, fakeAgentToken), slog.Default())
		t.Cleanup(client.Close)

		events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{RecipeID: "r1", RuntimeID: "rt1"})
		if err != nil {
			t.Fatalf("StreamVmProvision: %v", err)
		}
		defer unsubscribe()

		got := drainVmProvisionEvents(t, events, 5*time.Second)
		if len(got) != 1 || got[0].Type != "result" {
			t.Fatalf("expected exactly one result event, got %+v", got)
		}
		r := got[0].Result
		if r.Type != "orca-server" || r.PairingCode != "pair-xyz" || r.ProjectRoot != "/vm/proj" {
			t.Errorf("unexpected result: %+v", r)
		}
	})

	t.Run("new connection ssh shape", func(t *testing.T) {
		agent := &fakeAgent{t: t, requireToken: fakeAgentToken, vmProvisionFrames: []map[string]any{
			{"type": "stream.started"},
			{"type": "stream.end", "exitCode": 0, "provisionResult": map[string]any{
				"ok": true,
				"result": map[string]any{
					"schemaVersion": 1,
					"connection": map[string]any{
						"type":        "ssh",
						"projectRoot": "/vm/proj-ssh",
						"target": map[string]any{
							"label": "vm-1", "host": "10.0.0.9", "port": 22, "username": "dev",
							"identityFile": "/home/dev/.ssh/id_ed25519", "identitiesOnly": true,
							"relayGracePeriodSeconds": 60,
							// CR-EVM-008/TASK-BE-EVM-021
							"portForwards": []map[string]any{
								{"localPort": 8080, "remoteHost": "127.0.0.1", "remotePort": 3000, "label": "dev server"},
							},
						},
					},
				},
			}},
		}}
		host, port := startFakeAgent(t, agent)
		client := New(testConfig(port, fakeAgentToken), slog.Default())
		t.Cleanup(client.Close)

		events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{RecipeID: "r1", RuntimeID: "rt1"})
		if err != nil {
			t.Fatalf("StreamVmProvision: %v", err)
		}
		defer unsubscribe()

		got := drainVmProvisionEvents(t, events, 5*time.Second)
		if len(got) != 1 || got[0].Type != "result" {
			t.Fatalf("expected exactly one result event, got %+v", got)
		}
		r := got[0].Result
		if r.Type != "ssh" || r.ProjectRoot != "/vm/proj-ssh" {
			t.Fatalf("unexpected result: %+v", r)
		}
		if r.SshTarget == nil {
			t.Fatal("expected SshTarget to be set for type=ssh")
		}
		if r.SshTarget.Host != "10.0.0.9" || r.SshTarget.Port != 22 || r.SshTarget.Username != "dev" ||
			r.SshTarget.IdentityFile != "/home/dev/.ssh/id_ed25519" || !r.SshTarget.IdentitiesOnly ||
			r.SshTarget.RelayGracePeriodSeconds != 60 {
			t.Errorf("unexpected SshTarget: %+v", r.SshTarget)
		}
		// CR-EVM-008/TASK-BE-EVM-021: portForwards must round-trip, not be
		// dropped like it deliberately was before this task.
		if len(r.SshTarget.PortForwards) != 1 {
			t.Fatalf("expected 1 port forward, got %+v", r.SshTarget.PortForwards)
		}
		fw := r.SshTarget.PortForwards[0]
		if fw.LocalPort != 8080 || fw.RemoteHost != "127.0.0.1" || fw.RemotePort != 3000 || fw.Label != "dev server" {
			t.Errorf("unexpected port forward: %+v", fw)
		}
	})
}

// TestStreamVmProvision_EmitsErrorEventOnNonZeroExit covers 3 distinct
// error paths handleVmProvision can produce in a stream.end frame: a
// non-zero exitCode, the catch-block's top-level "error" field (agent-side
// exception), and provisionResult.ok==false (malformed recipe stdout).
func TestStreamVmProvision_EmitsErrorEventOnNonZeroExit(t *testing.T) {
	t.Run("non-zero exitCode", func(t *testing.T) {
		agent := &fakeAgent{t: t, requireToken: fakeAgentToken, vmProvisionFrames: []map[string]any{
			{"type": "stream.started"},
			{"type": "stream.end", "exitCode": 1},
		}}
		host, port := startFakeAgent(t, agent)
		client := New(testConfig(port, fakeAgentToken), slog.Default())
		t.Cleanup(client.Close)

		events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{RecipeID: "r1", RuntimeID: "rt1"})
		if err != nil {
			t.Fatalf("StreamVmProvision: %v", err)
		}
		defer unsubscribe()

		got := drainVmProvisionEvents(t, events, 5*time.Second)
		if len(got) != 1 || got[0].Type != "error" {
			t.Fatalf("expected exactly one error event, got %+v", got)
		}
	})

	t.Run("agent-side exception (catch block)", func(t *testing.T) {
		agent := &fakeAgent{t: t, requireToken: fakeAgentToken, vmProvisionFrames: []map[string]any{
			{"type": "stream.started"},
			{"type": "stream.end", "exitCode": -1, "error": "recipe process spawn failed: ENOENT"},
		}}
		host, port := startFakeAgent(t, agent)
		client := New(testConfig(port, fakeAgentToken), slog.Default())
		t.Cleanup(client.Close)

		events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{RecipeID: "r1", RuntimeID: "rt1"})
		if err != nil {
			t.Fatalf("StreamVmProvision: %v", err)
		}
		defer unsubscribe()

		got := drainVmProvisionEvents(t, events, 5*time.Second)
		if len(got) != 1 || got[0].Type != "error" || got[0].ErrorMsg != "recipe process spawn failed: ENOENT" {
			t.Fatalf("unexpected events: %+v", got)
		}
	})

	t.Run("provisionResult.ok==false", func(t *testing.T) {
		agent := &fakeAgent{t: t, requireToken: fakeAgentToken, vmProvisionFrames: []map[string]any{
			{"type": "stream.started"},
			{"type": "stream.end", "exitCode": 0, "provisionResult": map[string]any{
				"ok": false, "error": "Recipe stdout must be one JSON object.",
			}},
		}}
		host, port := startFakeAgent(t, agent)
		client := New(testConfig(port, fakeAgentToken), slog.Default())
		t.Cleanup(client.Close)

		events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{RecipeID: "r1", RuntimeID: "rt1"})
		if err != nil {
			t.Fatalf("StreamVmProvision: %v", err)
		}
		defer unsubscribe()

		got := drainVmProvisionEvents(t, events, 5*time.Second)
		if len(got) != 1 || got[0].Type != "error" || got[0].ErrorMsg != "Recipe stdout must be one JSON object." {
			t.Fatalf("unexpected events: %+v", got)
		}
	})
}

// TestStreamVmProvision_UnsubscribeStopsDemux calls unsubscribe mid-stream
// (before stream.end arrives) and asserts the event channel closes cleanly
// with no panic — mirrors TestSession_UnsubscribeScreencast_ClosesChannelAndStopsRouting's
// "closes cleanly, no leaked goroutine left signaling a dead channel"
// discipline.
func TestStreamVmProvision_UnsubscribeStopsDemux(t *testing.T) {
	agent := &fakeAgent{t: t, requireToken: fakeAgentToken, vmProvisionFrames: []map[string]any{
		{"type": "stream.started"},
		{"type": "stream.chunk", "line": "still going..."},
		// Deliberately no stream.end — this test unsubscribes before one
		// would ever arrive, exercising the early-cancellation path.
	}}
	host, port := startFakeAgent(t, agent)
	client := New(testConfig(port, fakeAgentToken), slog.Default())
	t.Cleanup(client.Close)

	events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{RecipeID: "r1", RuntimeID: "rt1"})
	if err != nil {
		t.Fatalf("StreamVmProvision: %v", err)
	}

	// Drain the one chunk we expect, then unsubscribe — must not panic, and
	// the channel must close soon after (never receive a second time forever).
	select {
	case <-events:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the first chunk")
	}

	unsubscribe()
	unsubscribe() // MUST be safe to call more than once (sync.Once), matching StreamPty/StreamScreencast's contract

	select {
	case _, ok := <-events:
		if ok {
			// A late in-flight frame is acceptable, but the channel must
			// still close afterward.
			select {
			case _, ok2 := <-events:
				if ok2 {
					t.Fatal("expected channel to close after unsubscribe")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for channel to close after unsubscribe")
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for channel to close after unsubscribe")
	}
}

// TestStreamVmProvision_AgentMethodNotFoundReturnsTypedError mirrors
// TestClientExecTranslatesMethodNotFound — an agent build too old to have
// vm.provision must translate to domain.ErrAgentMethodNotFound, detected
// synchronously (StreamVmProvision blocks for the dispatcher's first frame,
// same "starting IS subscribing" discipline as StreamScreencast), not as the
// channel's first event.
func TestStreamVmProvision_AgentMethodNotFoundReturnsTypedError(t *testing.T) {
	agent := &fakeAgent{t: t, requireToken: fakeAgentToken, results: map[string]any{}} // no vm.provision registered
	host, port := startFakeAgent(t, agent)
	client := New(testConfig(port, fakeAgentToken), slog.Default())
	t.Cleanup(client.Close)

	events, unsubscribe, err := client.StreamVmProvision(context.Background(), vmProvisionTestDevServer(t, host), usecase.VmProvisionParams{RecipeID: "r1", RuntimeID: "rt1"})
	if err == nil {
		if unsubscribe != nil {
			unsubscribe()
		}
		t.Fatal("expected an error for a method the fake agent doesn't implement")
	}
	if !errors.Is(err, domain.ErrAgentMethodNotFound) {
		t.Errorf("expected errors.Is(err, domain.ErrAgentMethodNotFound), got %v", err)
	}
	if events != nil {
		t.Errorf("expected a nil events channel on error, got %v", events)
	}
}
