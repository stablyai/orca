# Antigravity terminal-backed Chat UI

Antigravity uses the existing experimental Chat UI over its terminal and saved
transcript. It is not a structured-session provider. The opt-in default-chat
setting applies when a real provider session is associated. New unassociated
Antigravity sessions start in Terminal and apply that preference when the execution
host supplies their CLI conversation ID. Resuming a known CLI conversation applies
the preference at launch. An explicit view choice or an unconfirmed restored row
is preserved; an IDE reference ID is not a CLI conversation ID.

## Transcript contract

The execution host reads
`.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.
A hook-reported transcript path takes precedence. Existing WSL exact-path and
host-isolation rules apply; id-only WSL reads derive the distro from the owning
hook server's canonical provider-session row and inspect only that guest.
Ambiguous or unavailable namespaces fail before reading a local file, including
provenance checks for SSH- or paired-owned IDs on the client. A missing guest transcript must not
fall back to a native host's same-named conversation. Direct SSH panes stay in the terminal:
that connection has no native-chat transcript transport, and its absolute file
path must never be opened on the client. Paired runtimes remain eligible because
their own host reads the transcript. Direct SSH chat support remains unfinished.

The sanitized fixture in `src/main/native-chat/__fixtures__/antigravity/` records
these observed shapes:

- User input is `USER_EXPLICIT/USER_INPUT` with a `USER_REQUEST` wrapper.
- Planner responses carry text, thinking, or tool calls. Tool arguments are in `args`.
- Tool output is a `MODEL` record with a tool-specific type such as `RUN_COMMAND`
  or `VIEW_FILE`. It is not a `TOOL_RESULT` record.
- A planner step marked `DONE` can precede more tool work in the same user turn.
  The decoder therefore emits no turn-completion verdict. The existing host-owned
  hook/status system remains authoritative.

Full reads, incremental tails, and legacy journal imports reuse the same decoder.
Unknown record types are skipped. Tool failures retain a nonzero exit code or
`ERROR` status as an error result.

## Mixed versions

New hosts advertise `native-chat.antigravity.v1`. A new client's chat transport
checks the owning host before reading or subscribing to Antigravity. An older
host gets the existing update-runtime error; a failed capability probe gets the
existing read error. Neither becomes a perpetual first-transcript wait.
No stream opcode or message-block type was added.

## Approvals and terminal ownership

Captured command menus publish an Allow/Deny card through the hook server's
canonical row. Allow sends the recorded one-time `1` key; Deny sends Escape to
the same terminal through the existing input transport. The publisher refuses
stale revisions, replaced terminal generations, unconfirmed restored rows,
unreadable screens, and lost execution-host contact. A WSL relay row must match
an explicitly known PTY distro; an unknown/default distro is not proof of a match.

The current trusted-grid checks and 1.2.14 agent-state rules remain in force.
Only the captured working layout or an idle composer can clear this producer's
card; the idle composer must remain quiet for three seconds. Pending timers
recheck the live row and screen before publication and are cancelled on PTY exit.
Output during a screen read replaces the pending quiet timer; callbacks and reads
from a forgotten PTY incarnation cannot reschedule or publish for its replacement.
No removed readiness module or reader-side status store was restored.

## Verification limits on the current port (2026-10-02)

The native CLI observations below are the original author's evidence preserved
from `09169edd23e2a56ee66f4d3d7b07403f0b04c478`, including its attached proof. The
subsequent review repair replays those committed captures and checks the rebuilt
hidden UI with private CLI/status/transcript fixtures. That fixture proof is not
a new authenticated native run or a new verification of hook delivery or model
generation.

The focused suites cover decoder/full-read/tail parity, unknown records, durable
journal imports, WSL path isolation and stalled reads, captured Windows approvals,
canonical-row revision/incarnation fences, current 1.2.14 readiness/quiescence,
capability refusal and transient probe failure, stream cancellation/reconnect,
Terminal/Chat eligibility and default view. Mobile also checks capabilities before
subscription and history reads. No new wire opcode or structured provider was added.

In a hidden macOS app built from this worktree, with a brand-new profile and
`agentStatusHooksEnabled=false` verified through the live store, a real Chat
composer send reached installed agy 1.2.14 in the same terminal and its saved
transcript. The provider returned “Individual quota reached” on Gemini 3.8 Flash
with a reset about 120 hours away. To inspect the real transcript in Chat without
installing hooks, the actual session ID/path was manually bound after matching the
submitted marker in that file. This is real read/send/toggle evidence, not proof
of automatic hook delivery, successful generation, or live Allow/Deny actions.

A subsequent isolated, authenticated Claude Sonnet turn reached an actual
`cat proof.txt` command approval on macOS agy 1.2.14. Its sanitized authoritative
159×69 main-buffer grid is recorded with a provenance sidecar and passes the
existing hold rule. The canonical hook-server snapshot remained empty on that
main build, so automatic Chat association and live Chat Allow/Deny remain
unverified pending the separately owned POSIX hook transport fix. This turn
proves real generation and the current permission layout, not completed tool
execution or a Chat approval card.

The committed Windows approval recordings came from the scoped predecessor and
remain historical 1.2.7 evidence. Current Windows/WSL/Linux/paired execution and
mobile device UI were not available here. These limits must accompany a successor
PR; keep #20157 open while its Cursor portion is absent. Accounts and IDE history
continuation are separate follow-ups.

## Adoption

Scoped recovery of #21660 and #21776 credits the original #15773 work by
@haoliangli. WSL transcript and relay-approval support recovers #24141 by
@sojiro-o. No old development branch was merged wholesale, and predecessors must
remain open until the successor lands.
