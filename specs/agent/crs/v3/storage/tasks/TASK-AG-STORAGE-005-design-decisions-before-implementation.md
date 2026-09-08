# TASK-AG-STORAGE-005: Resolve open design decisions before implementing the agent-spawn daemon

**Task ID:** TASK-AG-STORAGE-005
**Priority:** 🔴 CRITICAL (blocks TASK-AG-STORAGE-006/007/008/009 — implementing before these are answered means guessing at an unowned contract)
**Solution Ref:** [SOL-AG-STORAGE-003](../solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md) §3
**Estimated effort:** Medium (investigation + a short decision doc, no production code)
**Dependencies:** None
**Status:** ✅ Done (2026-09-07)

---

## Context

`SOL-AG-STORAGE-003` designed applying the existing terminal-PTY
daemon+grace-period pattern (`pty-daemon-server.ts`) to AI-agent CLI PTYs
(`agent-spawner.ts`'s `PTY_REGISTRY`), but explicitly left 3 questions
**undecided** (§3 of that solution) because answering them requires
reading code this pass didn't fully read. Implementing
TASK-AG-STORAGE-006/007/008/009 without these answers risks building on a
guessed foundation — this task exists specifically to close that gap
first, per the same discipline `SOL-AG-PW-001` already established for
this repo ("don't build things you can't verify end-to-end").

## What to do

### Decision 1 — Where does the OSC state machine live after the split?

`specs/agent/tdd/v5/00-index.md` §A.6 describes an OSC sequence parsing
state machine (`idle → running → waiting_for_input → completed`) that
watches AI-agent CLI output to detect status changes, emitted as
`agent.statusChanged` events.

1. Locate this state machine's real implementation in `agent/src/relay/`
   (likely near `agent-spawner.ts` or a dedicated OSC-parsing module —
   confirm by reading, don't assume the filename).
2. Determine whether it needs to see **every byte** of PTY output in
   real time to work correctly, or whether it can be **replayed** against
   a buffered scrollback after the fact.
3. Decide: (a) move the state machine into the new daemon process
   alongside the PTY itself (keeps it always-on, but couples the daemon
   to spawner-specific parsing logic the terminal-PTY daemon doesn't
   have), or (b) keep it in the agent (WS-client) process and re-derive
   state from a buffered output tail after a reattach (simpler daemon,
   but a brief detection gap while the agent process is down/reconnecting).
4. Record the decision and rationale.

### Decision 2 — One shared daemon, or a second dedicated one?

1. Re-read `pty-daemon-server.ts`/`pty-daemon-protocol.ts`/`pty-daemon-client.ts`
   in full to assess how generically they're written today (are `pty.*`
   method names/params hardcoded into the protocol layer, or is there a
   generic request/response envelope that a second method family
   (`agent.spawn`/`agent.kill`) could reuse with minimal duplication?).
2. Decide: (a) extend the existing PTY daemon to also host AI-agent CLI
   PTYs (one Unix socket, one idle-shutdown timer, dispatch by method
   name), or (b) stand up a second, dedicated daemon
   (`agent-spawn-daemon-*`) as originally sketched in
   `SOL-AG-STORAGE-003` §2.
3. Record the decision and rationale — weigh blast radius (a shared
   daemon means a crash there now also affects terminals) against
   duplication cost (a second daemon repeats the idle-shutdown/probe/
   socket-lifecycle boilerplate).

### Decision 3 — Is `desktop/src/relay/` still a live build target?

1. Confirm whether `desktop/src/relay/agent-spawner.ts` (and its sibling
   PTY-daemon files, if they exist there) is still built/shipped, or
   whether `desktop/` has been superseded by `agent/` as the actual
   deployed Dev Server Agent (check build scripts, `package.json`
   entrypoints referenced by `specs/agent/tdd/v5/00-index.md`'s "Build
   Output" section, and any recent commit history indicating one replaced
   the other).
2. If `desktop/src/relay/` is dead code / no longer built: record that
   finding explicitly (with evidence) so TASK-AG-STORAGE-009 can skip the
   mirror-sync step instead of doing it defensively.
3. If it is still live: confirm exactly which files need to change in
   lockstep and note them for TASK-AG-STORAGE-009.

## Acceptance Criteria

- [x] All 3 decisions above are answered with cited evidence (file:line),
      not assumed.
- [x] Answers appended to `SOL-AG-STORAGE-003` as a new "§3a — Quyết định
      thiết kế đã chốt" section (do not silently overwrite §3 — keep the
      original open-questions framing, then resolve it).
- [x] No production code changed in this task — investigation + decision
      recording only.

## Handoff

TASK-AG-STORAGE-006 through 009 must not start implementation until this
task's decisions are recorded — each of those tasks references back to
this one's outcome for its exact file layout.


---

## ✅ Completion Notes (2026-09-07) — all 3 decisions resolved, 2 of 3 turned out simpler than expected

### Decision 1 — OSC state machine placement: MOOT, it doesn't exist

Searched `agent/src/` broadly (`codegraph_explore` for "agent.statusChanged
OSC sequence parsing state machine idle running waiting_for_input
completed") — found no such state machine. The only OSC-parsing code that
exists, `agent/src/shared/terminal-osc-color-reply.ts`, is an unrelated
concern (terminal foreground/background color query/reply, `OSC 10/11 ?`)
with nothing to do with AI-agent status detection.

What *does* exist and is real: `agent-spawner.ts`'s `SubAgentSpawner`
class, a simple `AgentLifecycleState` enum
(`idle|spawning|running|stopping|stopped|error`) with an explicit
`transition(next)` method and a hardcoded valid-transitions table — not
derived by watching PTY output byte-by-byte, just flipped by the
`agent.spawn`/`agent.kill` handlers themselves.

**Decision: no relocation problem exists.** `specs/agent/tdd/v5/00-index.md`
§A.6's "OSC sequence parsing state machine (idle → running →
waiting_for_input → completed)" describes a mechanism that was never built
this way (or was superseded before it shipped) — flagging as another
`00-index.md` inaccuracy, out of TASK-AG-STORAGE-004's original scope but
worth a follow-up note there. `SubAgentSpawner`'s real, simpler
`AgentLifecycleState` has no byte-parsing dependency and can move into the
daemon (TASK-AG-STORAGE-006) as plain in-memory state, transitioned by the
same `agent.spawn`/`agent.kill` daemon-side handlers — no special design
needed.

### Decision 2 — one shared daemon, not a second one

Read `pty-daemon-protocol.ts` in full: `DaemonRequest{id, method, params}`
/ `DaemonResponse{id, result?, error?}` / `DaemonNotification{method,
params}`, dispatched purely by `method` string. **Nothing PTY-specific is
baked into the protocol layer** — it's already a fully generic
JSON-RPC-over-NDJSON-over-Unix-socket transport.

**Decision: extend the existing `pty-daemon-server.ts` rather than stand
up a second daemon.** Adding `agent.spawn`/`agent.kill`/`agent.sendInput`
as new `case` branches in `dispatchDaemonRequest()` is a small, low-risk
addition; a second daemon would duplicate the idle-shutdown timer,
startup self-dedup probe, and socket lifecycle handling for no isolation
benefit that clearly outweighs that duplication. This **simplifies**
TASK-AG-STORAGE-006 — no new `agent-spawn-daemon-*.ts` files, no second
Unix socket, no second idle-shutdown timer. TASK-AG-STORAGE-006 has been
updated accordingly (see that task's own completion trail once
implemented).

### Decision 3 — `desktop/src/relay/` is legacy, not a live build target

Evidence, most-to-least direct:
1. Root `package.json:49` — `"build:agent": "node agent/build.mjs"`. This
   is the canonical, monorepo-level build command, and it points at
   `agent/`, not `desktop/`.
2. `agent/build.mjs`'s own header comment: "agent/ is fully self-contained"
   (no `../..` hop into the monorepo root the way `desktop/config/scripts/
   build-agent-only.mjs` needs).
3. Commit `5edb9a739` (2026-09-04, "refactor(agent,packages): extract
   dev-agent-transport wire protocol; agent/ package-split follow-ups")
   explicitly describes `agent/` as "a headless relay/dev-server package
   **split from desktop/**."
4. `git log` shows `desktop/src/relay/agent-spawner.ts` was last touched
   2026-08-09 by a generic, non-descriptive commit ("update code"),
   predating the deliberate Sep 4 package-split — consistent with it being
   an unmaintained leftover from before the split, not a second live copy.

`desktop/package.json` still defines local `build:relay`/`build:agent`
scripts pointing at `desktop/config/scripts/build-agent-only.mjs`, so the
old path is not *deleted* — but it is not what the root-level build
invokes, and its last content change predates the split.

**Decision: treat `desktop/src/relay/` as dead for the purposes of
TASK-AG-STORAGE-006/007/009 — do not mirror the daemon changes there.**
Recommend (as a separate, out-of-scope follow-up, not part of this CR) that
someone confirm this fully and delete `desktop/src/relay/`'s duplicate
files outright, rather than leaving a second, silently-drifting copy in
the tree indefinitely.

## Handoff (updated)

TASK-AG-STORAGE-006 can proceed as **"extend `pty-daemon-server.ts`"**
rather than "build `agent-spawn-daemon-*.ts`" — a smaller task than
originally scoped. TASK-AG-STORAGE-009's Part 1 (desktop mirror) is now
"confirm and skip, cite this decision" rather than "port changes."
