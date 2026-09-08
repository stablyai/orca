// methods.go holds the typed pty.* JSON-RPC wrappers TASK-181/183 add to
// DevServerAgentClient (SpawnPty/WritePty/ResizePty/KillPty/SendSignal/
// AgentStatus/InspectProcess — StreamPty lives in client.go alongside
// session management, see that file). Every method name/param shape below
// EXCEPT AgentStatus's ReadyForInput heuristic is grounded in the real
// agent source (agent/src/relay/agent-rpc-dispatch.ts's pty.* case block,
// pty-daemon-client.ts's exported handlers, and
// pty-agent-bridge.ts's real per-method implementations) — see each doc
// comment for the exact citation. AgentStatus.ReadyForInput remains a
// documented heuristic: see its own doc comment for why.
package devserveragent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"
)

// SpawnPty calls pty.create. Params/result shape confirmed via
// agent-rpc-dispatch.ts's doc comment on the 'pty.create' case:
// `Params: { cwd, cols?, rows?, env?, shellOverride? }` /
// `Returns: { id, cols, rows, cwd, shell }`. env is not threaded through
// SpawnPtyInput (no caller populates it yet — usecase.SpawnPtyInput has no
// Env field); shellOverride is SpawnPtyInput.Shell renamed to match the
// agent's actual param name.
func (c *Client) SpawnPty(ctx context.Context, devServer domain.DevServer, in usecase.SpawnPtyInput) (usecase.SpawnPtyResult, error) {
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return usecase.SpawnPtyResult{}, err
	}

	params := map[string]any{"cwd": in.Cwd}
	if in.Shell != "" {
		params["shellOverride"] = in.Shell
	}
	if in.Cols > 0 {
		params["cols"] = in.Cols
	}
	if in.Rows > 0 {
		params["rows"] = in.Rows
	}

	raw, err := sess.call(ctx, "pty.create", params)
	if err != nil {
		return usecase.SpawnPtyResult{}, err
	}
	var out struct {
		ID    string `json:"id"`
		Cols  int32  `json:"cols"`
		Rows  int32  `json:"rows"`
		Cwd   string `json:"cwd"`
		Shell string `json:"shell"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			return usecase.SpawnPtyResult{}, fmt.Errorf("devserveragent: decoding pty.create result: %w", err)
		}
	}
	if out.ID == "" {
		// A silently empty PtyID would surface as a hard-to-diagnose failure
		// several layers up (usecase code keying off PtyID) — fail loudly here
		// instead, at the one place that knows the response was malformed.
		return usecase.SpawnPtyResult{}, fmt.Errorf("devserveragent: pty.create response missing id")
	}
	return usecase.SpawnPtyResult{PtyID: out.ID, Cols: out.Cols, Rows: out.Rows, Cwd: out.Cwd, Shell: out.Shell}, nil
}

// WritePty calls pty.write. Params confirmed via agent-rpc-dispatch.ts's
// doc comment on the 'pty.write' case: `Params: { id, data }`.
func (c *Client) WritePty(ctx context.Context, devServer domain.DevServer, ptyID string, data []byte) error {
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return err
	}
	_, err = sess.call(ctx, "pty.write", map[string]any{"id": ptyID, "data": string(data)})
	return err
}

// ResizePty calls pty.resize. Params confirmed via agent-rpc-dispatch.ts's
// doc comment on the 'pty.resize' case: `Params: { id, cols, rows }`.
func (c *Client) ResizePty(ctx context.Context, devServer domain.DevServer, ptyID string, cols, rows int32) error {
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return err
	}
	_, err = sess.call(ctx, "pty.resize", map[string]any{"id": ptyID, "cols": cols, "rows": rows})
	return err
}

// KillPty calls pty.destroy. Params confirmed via agent-rpc-dispatch.ts's
// doc comment on the 'pty.destroy' case: `Params: { id, graceful? }`.
func (c *Client) KillPty(ctx context.Context, devServer domain.DevServer, ptyID string, graceful bool) error {
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return err
	}
	_, err = sess.call(ctx, "pty.destroy", map[string]any{"id": ptyID, "graceful": graceful})
	return err
}

// allowedSignals mirrors agent/src/relay/pty-agent-bridge.ts's
// ALLOWED_SIGNALS set exactly — the agent rejects (-32602) anything outside
// this set, so failing fast here gives a clearer error than a round trip.
var allowedSignals = map[string]bool{
	"SIGTERM": true, "SIGKILL": true, "SIGINT": true, "SIGHUP": true, "SIGTSTP": true,
}

// SendSignal calls pty.sendSignal — CONFIRMED real (TASK-183): the RPC is
// registered in agent/src/relay/agent-rpc-dispatch.ts's 'pty.sendSignal'
// case, forwarded verbatim by pty-daemon-client.ts's handlePtySendSignal to
// the daemon-side implementation in pty-agent-bridge.ts's own
// handlePtySendSignal, whose doc comment confirms
// `Params: { id, signal }` and ALLOWED_SIGNALS = {SIGTERM, SIGKILL, SIGINT,
// SIGHUP, SIGTSTP}. This replaces the former StopTerminalProcess-sends-
// Ctrl-C(0x03)-via-WritePty workaround with a real signal primitive.
func (c *Client) SendSignal(ctx context.Context, devServer domain.DevServer, ptyID string, signal string) error {
	if !allowedSignals[signal] {
		return fmt.Errorf("devserveragent: signal %q not in the agent's allowed set (SIGTERM/SIGKILL/SIGINT/SIGHUP/SIGTSTP)", signal)
	}
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return err
	}
	_, err = sess.call(ctx, "pty.sendSignal", map[string]any{"id": ptyID, "signal": signal})
	return err
}

// ptyProcessSummary mirrors pty-agent-bridge.ts's handlePtyListProcesses
// result shape: {id, cwd, title, pid} per live pty (pid added in this pass —
// see that function's doc comment — so InspectProcess can report a real pid
// instead of always 0).
type ptyProcessSummary struct {
	ID    string `json:"id"`
	Cwd   string `json:"cwd"`
	Title string `json:"title"`
	Pid   int32  `json:"pid"`
}

// findPtyProcess calls pty.listProcesses (confirmed real, see
// agent-rpc-dispatch.ts's 'pty.listProcesses' case and
// pty-daemon-client.ts's handlePtyListProcesses) and returns the entry
// matching ptyID — the shared lookup AgentStatus/InspectProcess both build
// on, since neither has a dedicated per-pty-id RPC confirmed in the real
// catalog (see both methods' FLAGGED doc comments).
func (c *Client) findPtyProcess(ctx context.Context, devServer domain.DevServer, ptyID string) (ptyProcessSummary, bool, error) {
	sess, err := c.getOrCreateSession(ctx, devServer)
	if err != nil {
		return ptyProcessSummary{}, false, err
	}
	raw, err := sess.call(ctx, "pty.listProcesses", map[string]any{})
	if err != nil {
		return ptyProcessSummary{}, false, err
	}
	var list []ptyProcessSummary
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &list); err != nil {
			return ptyProcessSummary{}, false, fmt.Errorf("devserveragent: decoding pty.listProcesses result: %w", err)
		}
	}
	for _, p := range list {
		if p.ID == ptyID {
			return p, true, nil
		}
	}
	return ptyProcessSummary{}, false, nil
}

// knownAgentTitles maps a foreground-process title substring to the
// AgentKind it implies — best-effort heuristic, see AgentStatus's FLAGGED
// doc comment.
var knownAgentTitles = []struct {
	substr string
	kind   string
}{
	{substr: "claude", kind: "claude"},
	{substr: "codex", kind: "codex"},
}

// AgentStatus answers "is an agentic CLI running in this pane, and is it
// ready for input" (GetTerminalAgentStatusResponse).
//
// CONFIRMED (TASK-183 follow-up): grepping agent/src/relay for an
// agent-status/isRunningAgent pty.* RPC still finds nothing — there is no
// dedicated primitive in the real catalog, and this remains a heuristic
// built on pty.listProcesses (see findPtyProcess): AgentRunning/AgentKind
// come from matching the foreground process title against knownAgentTitles.
// ReadyForInput is STILL set equal to AgentRunning and genuinely can't be
// improved without an agent-side change beyond this pass's scope:
// pty-agent-bridge.ts's handlePtyListProcesses (the confirmed real
// implementation) reports only {id,cwd,title,pid} — no busy/idle signal
// exists anywhere in the agent's pty.* RPC surface to distinguish "actively
// streaming a response" from "idle at a prompt". Closing this for real needs
// a new agent-side RPC (e.g. a raw-output-quiescence timer or an explicit
// prompt-detection signal), not just wiring — left as a known, honestly
// documented gap.
func (c *Client) AgentStatus(ctx context.Context, devServer domain.DevServer, ptyID string) (usecase.AgentStatusResult, error) {
	proc, found, err := c.findPtyProcess(ctx, devServer, ptyID)
	if err != nil {
		return usecase.AgentStatusResult{}, err
	}
	if !found {
		return usecase.AgentStatusResult{}, nil
	}
	kind := agentKindFromTitle(proc.Title)
	running := kind != ""
	return usecase.AgentStatusResult{AgentRunning: running, AgentKind: kind, ReadyForInput: running}, nil
}

// DialHiddenSshTarget calls vm.sshDial (BE-SOL-EVM-004 §3 / "Quyết định đã
// chốt" mục 1) — credential material in target is sent as ordinary RPC
// params over the SAME agent<->Orca channel vm.exec already uses (Exec,
// not a new streaming/session mechanism), mirroring how vm.exec's
// recipeId/runtimeId params already travel (TASK-BE-EVM-001). The agent
// method itself does not exist yet as of this pass (TASK-AG-EVM-006,
// running in parallel) — a real agent build without it answers with the
// standard JSON-RPC "method not found", which Exec already turns into
// domain.ErrAgentMethodNotFound (see Exec's own doc comment), letting
// usecase.AgentOutboundSshProvisioner.Provision surface a clear
// FailedPrecondition instead of a raw transport error.
func (c *Client) DialHiddenSshTarget(ctx context.Context, devServer domain.DevServer, runtimeID string, target domain.EphemeralVmSshTarget) (string, error) {
	params := map[string]any{
		"runtimeId": runtimeID,
		"target": map[string]any{
			"host":                target.Host,
			"port":                target.Port,
			"username":            target.Username,
			"privateKeyPem":       target.PrivateKeyPEM,
			"identityAgentSocket": target.IdentityAgentSocket,
			"jumpHost":            target.JumpHost,
			"proxyCommand":        target.ProxyCommand,
		},
	}

	result, err := c.Exec(ctx, devServer, "vm.sshDial", params)
	if err != nil {
		return "", err
	}

	hiddenTargetID, _ := result["hiddenTargetId"].(string)
	if hiddenTargetID == "" {
		// Convention: hiddenTargetID == runtimeID (BE-SOL-EVM-004 §4) — an
		// agent build that acks without echoing one back still counts as a
		// successful dial, just falls back to the convention value rather
		// than treating a missing echo as an error.
		hiddenTargetID = runtimeID
	}
	return hiddenTargetID, nil
}

func agentKindFromTitle(title string) string {
	lower := strings.ToLower(title)
	for _, k := range knownAgentTitles {
		if strings.Contains(lower, k.substr) {
			return k.kind
		}
	}
	return ""
}

// InspectProcess answers InspectTerminalProcessRequest — Known=true when
// pty.listProcesses reports an entry for ptyID (Command=its title,
// Cwd=its cwd, Pid=its pid), Known=false otherwise (a real "unknown", per
// InspectTerminalProcessResponse's own doc comment, not a fabricated zero
// value).
//
// Pid is now real (TASK-183 follow-up): pty-agent-bridge.ts's
// handlePtyListProcesses was extended to include `pid: entry.pty.pid`
// (previously {id,cwd,title} only) specifically so this method didn't have
// to hardcode 0. Note this is the PTY's own (shell) process id, not
// necessarily the foreground child process's pid — the agent has no RPC
// that exposes the latter.
func (c *Client) InspectProcess(ctx context.Context, devServer domain.DevServer, ptyID string) (usecase.InspectProcessResult, error) {
	proc, found, err := c.findPtyProcess(ctx, devServer, ptyID)
	if err != nil {
		return usecase.InspectProcessResult{}, err
	}
	if !found {
		return usecase.InspectProcessResult{Known: false}, nil
	}
	return usecase.InspectProcessResult{Known: true, Command: proc.Title, Cwd: proc.Cwd, Pid: proc.Pid}, nil
}
