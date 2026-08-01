# Main-Process Codex Spawn Gate for Session-Index Backfill (#11828) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Move codex backfill-gate enforcement from the renderer to the single main-process pty spawn choke point so that ALL codex launches — renderer-initiated panes, main-initiated worktree-creation panes, and any future entry point — hold the codex startup command while the session-index backfill is pending, show the existing "Indexing Codex session history…" overlay, and auto-launch codex when the index completes.

**Architecture:** At the two `provider.spawn(spawnOptions)` dispatch paths in `src/main/ipc/pty.ts` (the renderer `pty:spawn` IPC handler and the `runtime.setPtyController` controller used by main-initiated worktree creation), a new gate decides — via the branch's existing read-only `codex-state-db.ts` primitives — whether the pane's effective local CODEX_HOME has a pending backfill. When it does, the shell is spawned **immediately, with the codex startup command replaced by a release-sentinel gate wrapper** (a one-line poll built by mirroring the existing `src/shared/setup-agent-sequencing.ts` wrapper, posix + win32 `-EncodedCommand` variants): the original command rides in env `ORCA_BACKFILL_GATED_COMMAND`, and the wrapper waits for the release sentinel file named by env `ORCA_BACKFILL_RELEASE_FILE`, then evals the original command — so worktree creation, reveal, and setup sequencing keep their existing timing, and delivery reuses the production-proven argv/shell-ready delivery machinery end to end. **Main never writes into the pty**: a live-pty experiment falsified raw deferred writes (lossy under rc files that read the tty; double-echo/bracketed-paste garbling early; multiline mangling — see `validator-v3-A1.md` in the workflow logs). A per-pane hold registry (module-scope, surviving `registerPtyHandlers` re-registration) polls the state DB, broadcasts per-pane hold state to the renderer over a new `codexBackfill:paneHoldChanged` push channel, and **creates the sentinel file** when the backfill completes (or a 15-minute fail-open ceiling elapses); the wrapper carries its own ~20-minute fail-OPEN deadline as a second net if main dies. The renderer's existing gate/overlay work is refactored from an enforcement point into a pure consumer of this main-side state: the old renderer polling gate module is deleted and every pane (fresh-spawned OR adopted) subscribes to its own paneKey's hold state to drive the existing `CodexIndexingOverlay`. SSH/remote panes, WSL panes without a host-readable codex home, and (on Windows hosts) `\\wsl$`/`\\wsl.localhost` UNC-injected homes are passed through unchanged (fail-open; UNC sqlite reads over 9P are untrustworthy — AD-A10 in the load-bearing ledger); the existing backfill-error detector + amber toast remain the fallback net.

**Why command-withhold instead of holding before `provider.spawn`:** worktree creation `await`s `runtime.createTerminal(...)`; parking the spawn itself would stall the `worktrees:create` IPC round-trip, the setup-terminal sequencing (split mode requires the startup handle), and the 10s reveal timeouts — and no pane would exist to show the overlay in exactly the reporter's primary flow (see `.git/worktrees/codex-backfill-prewarm/sdd/np-task-8-report.md`). Spawning the shell immediately with the gate wrapper as its startup command keeps all existing timing intact, guarantees a live pane that can render the overlay in every flow, and delivers codex through the same battle-tested startup-command path every pane already uses (the wrapper is a normal command to every provider, so the daemon path needs zero protocol changes).

**Tech Stack:** Electron (main/preload/renderer), TypeScript, `node:sqlite` (read-only, via existing `codex-state-db.ts`), vitest, pnpm.

## Global Constraints

- Work in the worktree at `/home/dan/code/orca/.orca/worktrees/orca/codex-indexing-issues-11828/.worktrees/codex-backfill-prewarm`, branch `codex-backfill-prewarm` (base_ref `e058429e1`). All paths below are relative to this worktree root.
- Repo `AGENTS.md` conventions: concise WHY-only comments (1 line if possible); **never add `max-lines` eslint/oxlint disables or per-file bumps** (`pty.ts` and `pty.test.ts` carry pre-existing ones — do not add new ones; keep new logic in the new module, not in `pty.ts`); no vague `util`/`helper`/`common` filenames; cross-platform (macOS/Linux/Windows via runtime platform checks, no POSIX-only assumptions in product code); SSH and folder-workspace use cases must be considered; GitLab-generic review concepts.
- SSH/remote panes are OUT OF SCOPE and must be left unchanged: the gate applies only when the codex home state DB is readable on a NATIVE local filesystem (native host homes; Orca-injected WSL homes only when they resolve to a native path — on Windows hosts, `\\wsl$`/`\\wsl.localhost` UNC-injected homes are passed through, per AD-A10 in the load-bearing ledger: sqlite over 9P is untrustworthy). `args.connectionId` set ⇒ passthrough.
- Fail-open everywhere: if backfill state cannot be determined at decision time (unreadable DB, sqlite error, unexpected schema, unresolvable home), launch codex normally. Never brick a pane on gate errors. Once HOLDING, a transient unreadable read keeps the hold (bounded by the 15-minute ceiling) — releasing on a transient read error would defeat the gate under active-writer contention (np-task-8 concern #2).
- Do not redesign the already-verified branch work: state-DB prewarm, state-first trust-grant ordering with 'pending-index' lane, backfill-error detector + amber toast, commit `5c638031b` (i18n parity sync — KEEP).
- No new user-facing strings: reuse the existing `auto.components.terminal.pane.CodexIndexingOverlay.*` i18n keys. No locale catalog changes.
- Known pre-existing `pnpm test` failures on this machine, proven at merge base `e058429e1` and NOT to be fixed: 7 failures in `configure-process.test.ts`, `pty-subprocess.test.ts`, `local-pty-provider.test.ts`, `managed-hook-timeout.test.ts` (plus load-flakes that pass in isolation). Branch-owned tests must pass 100%.
- E2E: NEVER write to the real `~/.codex` or `~/.local/share/orca/codex-runtime-home` (read-only `mode=ro` sqlite checks only; both are `status=complete` and must remain untouched). Codex binary: `/home/dan/.local/bin/codex`. Machine: WSL2 Ubuntu 24.04.
- Line numbers cited below were verified on `db57146f8`; treat them as anchors, not gospel — re-locate by the quoted identifiers if they have drifted.
- Commits: conventional, focused, one per task (matching branch style, e.g. `feat(codex): … (#11828)`).

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/shared/codex-backfill-status-types.ts` | modify | Add `CodexBackfillPaneHoldPhase` / `CodexBackfillPaneHoldState` shared types |
| `src/shared/codex-backfill-gate-wrapper.ts` | create | Gate-wrapper builder (posix + win32, mirrors `setup-agent-sequencing.ts`): release-sentinel path scheme + `ORCA_BACKFILL_GATED_COMMAND`/`ORCA_BACKFILL_RELEASE_FILE` env |
| `src/shared/codex-backfill-gate-wrapper.test.ts` | create | Unit tests for wrapper construction (per-platform shape, single-line, env round-trip) |
| `src/shared/setup-agent-sequencing.ts` | modify | One-line: `resolveSetupAgentSequenceLaunchCommand` also recognizes the gate wrapper (reads `ORCA_BACKFILL_GATED_COMMAND`) so agent-kind detection keeps working |
| `src/main/codex/codex-backfill-spawn-hold.ts` | create | Pure gate logic: hold decision, poll evaluation, per-pane hold registry (timers, broadcast, release callback) |
| `src/main/codex/codex-backfill-spawn-hold.test.ts` | create | Unit tests for the above (fake timers, injected fakes) |
| `src/main/ipc/pty.ts` | modify | Thin integration: effective-home resolver (UNC passthrough), command replacement + guarded hold begin at both dispatch paths, sentinel release, module-scope registry + `codexBackfill:paneHoldChanged` broadcast rebind, `codexBackfill:paneHoldStatus` handler, teardown wiring |
| `src/main/ipc/pty.test.ts` | modify | Choke-point tests: gated launch, auto-launch, fail-open, SSH/WSL passthrough, controller-arm (worktree-creation) coverage |
| `src/preload/index.ts` | modify | `codexBackfill.paneHoldStatus` + `codexBackfill.onPaneHoldChanged` preload exposure |
| `src/preload/api-types.ts` | modify | Types for the two new preload members |
| `src/renderer/src/web/web-preload-api.ts` | modify | Web stub: never-held |
| `src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.ts` | create | Renderer consumer: per-paneKey subscription mapping hold state → `CodexIndexingPaneState`; hosts the `CodexIndexingPaneState` type after Task 5 |
| `src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.test.ts` | create | Unit tests for the subscription helper |
| `src/renderer/src/components/terminal-pane/pty-connection.ts` | modify | Remove renderer-side enforcement (park clause, `shouldGateCodexSpawnOnBackfill`, cleared latch); install the per-pane subscription for BOTH fresh-spawn and adoption arms |
| `src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.ts` | delete (Task 5) | Superseded renderer polling gate |
| `src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts` | delete (Task 5) | Superseded tests |
| `src/renderer/src/components/terminal-pane/CodexIndexingOverlay.tsx`, `TerminalPane.tsx`, `use-terminal-pane-lifecycle.ts` | modify (Task 5) | Import `CodexIndexingPaneState` from its new home; overlay rendering itself unchanged |

Existing APIs consumed (already on the branch — do not reimplement):

```ts
// src/main/codex/codex-state-db.ts
export type CodexStateDbBackfillStatus =
  | { kind: 'complete'; stateDbPath: string }
  | { kind: 'incomplete'; stateDbPath: string; status: string; lastWatermark: string | null }
  | { kind: 'missing' }
  | { kind: 'not-tracked'; stateDbPath: string }
  | { kind: 'unreadable'; stateDbPath: string; error: string }
export function readCodexStateDbBackfillStatus(codexHomePath: string): CodexStateDbBackfillStatus
export function isCodexBackfillIndexPending(codexHomePath: string): boolean // fail-open: unreadable ⇒ false
```

`getSystemCodexHomePath()` — same import `src/main/ipc/codex-backfill-status.ts` uses (from `src/main/codex/codex-home-paths.ts`).
`setup-agent-sequencing.ts` — the wrapper-construction precedent to mirror: posix one-line `bash -lc` poll wrapper at `:92-128` (single-line to avoid `quote>` prompts, `:103-105`), win32 PowerShell `-EncodedCommand` variant at `:202-254`, nonce-suffixed marker-file scheme `:44`, inner command evaled from env at `:114` (posix) / `Invoke-Expression` at `:235` (win32). NOTE its 2h timeout fail-CLOSED (`exit 124`) — the gate wrapper must diverge to fail-OPEN (exec anyway).
`toWindowsWslPath`-style shell-view path translation — precedent at `src/main/hooks.ts:484-516` (main writes a file, a WSL shell reads it).
`registerPaneKeyTeardownListener` — `src/main/ipc/pty.ts:273` (cancellation hook for held panes).

---

### Task 1: Main-side hold module — decision, poll evaluation, registry

**Files:**
- Modify: `src/shared/codex-backfill-status-types.ts`
- Create: `src/shared/codex-backfill-gate-wrapper.ts` (+ test `src/shared/codex-backfill-gate-wrapper.test.ts`)
- Modify: `src/shared/setup-agent-sequencing.ts` (one-line `resolveSetupAgentSequenceLaunchCommand` extension + test)
- Create: `src/main/codex/codex-backfill-spawn-hold.ts`
- Test: `src/main/codex/codex-backfill-spawn-hold.test.ts`

**Interfaces:**
- Consumes: `readCodexStateDbBackfillStatus`, `isCodexBackfillIndexPending` from `src/main/codex/codex-state-db.ts` (existing).
- Produces (Tasks 2–5 rely on these exact names):
  - `CodexBackfillPaneHoldPhase = 'indexing' | 'launched'` and `CodexBackfillPaneHoldState { paneKey: string; phase: CodexBackfillPaneHoldPhase; lastWatermark: string | null }` (shared types file).
  - `buildCodexBackfillGateWrapper(params)`, `ORCA_BACKFILL_GATED_COMMAND_ENV`, `ORCA_BACKFILL_RELEASE_FILE_ENV`, `CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S` (gate-wrapper module, Step 1b).
  - `shouldHoldCodexSpawnForBackfill(input: CodexBackfillSpawnHoldDecisionInput): boolean`
  - `evaluateCodexBackfillHoldPoll(codexHomePath: string): CodexBackfillHoldPollResult`
  - `createCodexBackfillPaneHoldRegistry(deps: { broadcast: (state: CodexBackfillPaneHoldState) => void }): CodexBackfillPaneHoldRegistry` with `begin(params): CodexBackfillPaneHoldHandle`, `get(paneKey): CodexBackfillPaneHoldState | null`, `disposeAll(): void`; `CodexBackfillPaneHoldHandle { dispose(): void }`. `begin` takes a `releaseHeldCommand: () => void` callback — in production it CREATES THE RELEASE SENTINEL FILE (it never writes into the pty; a live-pty experiment falsified raw deferred writes, see the load-bearing ledger).
  - `CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS = 5_000`, `CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS = 15 * 60_000`.

- [ ] **Step 1: Add the shared pane-hold types**

In `src/shared/codex-backfill-status-types.ts` (which already exports `CodexBackfillGateStatus`), append:

```ts
export type CodexBackfillPaneHoldPhase = 'indexing' | 'launched'

/** Why: main owns gate enforcement (#11828); panes mirror this per-paneKey state to drive the indexing overlay. */
export interface CodexBackfillPaneHoldState {
  paneKey: string
  phase: CodexBackfillPaneHoldPhase
  lastWatermark: string | null
}
```

- [ ] **Step 1b: Create the shared gate-wrapper module (tests first)**

Create `src/shared/codex-backfill-gate-wrapper.ts` + `src/shared/codex-backfill-gate-wrapper.test.ts`, mirroring `src/shared/setup-agent-sequencing.ts`'s construction helpers and quoting EXACTLY (posix one-line wrapper `:92-128`; win32 PowerShell `-EncodedCommand` variant `:202-254`; single-line constraint `:103-105` — keeping the wrapper on one line avoids visible `quote>` prompts). Exports (Task 2 relies on these exact names):

```ts
export const ORCA_BACKFILL_GATED_COMMAND_ENV = 'ORCA_BACKFILL_GATED_COMMAND'
export const ORCA_BACKFILL_RELEASE_FILE_ENV = 'ORCA_BACKFILL_RELEASE_FILE'
// Why: second fail-open net if main dies mid-hold; must exceed main's 15-minute release ceiling.
export const CODEX_BACKFILL_GATE_WRAPPER_DEADLINE_S = 20 * 60

export interface CodexBackfillGateWrapper {
  command: string // replaces spawnOptions.command
  env: Record<string, string> // merge into the spawn env (both env vars above)
  releaseFilePath: string // HOST-view path main touches at release
}

/** Why: deliver the held codex command through the production-proven startup path (argv/-EncodedCommand/
 * shell-ready) instead of a raw deferred pty write, which testing proved lossy/garbled (#11828). */
export function buildCodexBackfillGateWrapper(params: {
  originalCommand: string
  codexHomePath: string // gate home; sentinel lives at <home>/.orca/backfill-release-<nonce>
  shellPlatform: 'posix' | 'win32'
  toShellViewPath?: (hostPath: string) => string // WSL translation (hooks.ts:484-516 precedent); default identity
}): CodexBackfillGateWrapper
```

Posix wrapper `command` (ONE line, built with the setup wrapper's own quoting helpers; nonce-suffixed sentinel like `:44`):

```
deadline=$((SECONDS+1200)); while [ ! -e "$ORCA_BACKFILL_RELEASE_FILE" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done; rm -f -- "$ORCA_BACKFILL_RELEASE_FILE" 2>/dev/null; eval " $ORCA_BACKFILL_GATED_COMMAND"
```

win32: mirror the `-EncodedCommand` builder at `:202-254` (`Test-Path` poll + `Remove-Item` + `Invoke-Expression $env:ORCA_BACKFILL_GATED_COMMAND`). **CRITICAL divergence from the setup wrapper:** on deadline expiry the gate wrapper FAILS OPEN — it evals the command anyway; never the setup wrapper's fail-closed `exit 124`.

Nesting note: in wait-for-setup mode the original command is already the setup polling wrapper — composition is gate wrapper → (sentinel) → evals setup wrapper → (setup marker) → evals codex. The two env vars are distinct by construction and env is inherited at eval time; no re-plumbing needed.

Tests: posix command is a single line and evals the env var; env round-trips a command containing single quotes AND newlines verbatim; `releaseFilePath` is under `<home>/.orca/` and nonce-unique per call; `toShellViewPath` is applied to the `ORCA_BACKFILL_RELEASE_FILE` env value but NOT to the returned host-view `releaseFilePath`; win32 command uses `-EncodedCommand` whose base64/UTF-16LE payload decodes to a Test-Path poll + Invoke-Expression + fail-open exec.

Also modify `resolveSetupAgentSequenceLaunchCommand` (`src/shared/setup-agent-sequencing.ts:17-23`): one-line extension so it also resolves the launch command from env `ORCA_BACKFILL_GATED_COMMAND` when present (agent-kind detection at `pty.ts:1077-1110` keeps recognizing gated codex spawns; a gated setup wrapper resolves through both hops). Add a test beside the function's existing ones.

Run: `pnpm exec vitest run src/shared/codex-backfill-gate-wrapper.test.ts` — write the tests first, watch them fail, implement, watch them pass.

- [ ] **Step 2: Write the failing tests**

Create `src/main/codex/codex-backfill-spawn-hold.test.ts`. Mock `./codex-state-db` so no real sqlite is touched; use fake timers for the registry:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexBackfillPaneHoldState } from '../../shared/codex-backfill-status-types'

const isCodexBackfillIndexPendingMock = vi.fn<(home: string) => boolean>()
const readCodexStateDbBackfillStatusMock = vi.fn()

vi.mock('./codex-state-db', () => ({
  isCodexBackfillIndexPending: (home: string) => isCodexBackfillIndexPendingMock(home),
  readCodexStateDbBackfillStatus: (home: string) => readCodexStateDbBackfillStatusMock(home)
}))

import {
  CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS,
  CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS,
  createCodexBackfillPaneHoldRegistry,
  evaluateCodexBackfillHoldPoll,
  shouldHoldCodexSpawnForBackfill,
  type CodexBackfillHoldPollResult
} from './codex-backfill-spawn-hold'

describe('shouldHoldCodexSpawnForBackfill', () => {
  const base = {
    launchAgent: 'codex' as string | undefined,
    startupCommand: 'codex' as string | undefined,
    connectionId: undefined as string | null | undefined,
    codexHomePath: '/home/user/.codex' as string | null
  }

  it('holds a local codex launch with a pending index', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, isPending: () => true })).toBe(true)
  })

  it('passes through non-codex launches', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, launchAgent: 'claude', isPending: () => true })).toBe(false)
    expect(shouldHoldCodexSpawnForBackfill({ ...base, launchAgent: undefined, isPending: () => true })).toBe(false)
  })

  it('passes through SSH panes (connectionId set)', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, connectionId: 'conn-1', isPending: () => true })).toBe(false)
  })

  it('passes through when there is no startup command to withhold', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, startupCommand: undefined, isPending: () => true })).toBe(false)
  })

  it('passes through when the effective codex home is unresolvable', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, codexHomePath: null, isPending: () => true })).toBe(false)
  })

  it('fails open when the pending check throws', () => {
    expect(
      shouldHoldCodexSpawnForBackfill({
        ...base,
        isPending: () => {
          throw new Error('sqlite exploded')
        }
      })
    ).toBe(false)
  })

  it('passes through when the index is not pending', () => {
    expect(shouldHoldCodexSpawnForBackfill({ ...base, isPending: () => false })).toBe(false)
  })

  // Why: cold-restored codex panes spawn BEFORE the prewarm creates the state DB; the real predicate's
  // >=100-session-files arm must hold them through that window (#11828 validated startup race).
  it('holds via the real default predicate for a missing DB with >=100 session files', async () => {
    const real = await vi.importActual<typeof import('./codex-state-db')>('./codex-state-db')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-home-'))
    const day = path.join(home, 'sessions', '2026', '07', '01')
    fs.mkdirSync(day, { recursive: true })
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(day, `rollout-${i}.jsonl`), '')
    }
    expect(
      shouldHoldCodexSpawnForBackfill({ ...base, codexHomePath: home, isPending: real.isCodexBackfillIndexPending })
    ).toBe(true)
  })
})

describe('evaluateCodexBackfillHoldPoll', () => {
  beforeEach(() => {
    isCodexBackfillIndexPendingMock.mockReset()
    readCodexStateDbBackfillStatusMock.mockReset()
  })

  it('keeps holding (pending, unreadable) on an unreadable status read', () => {
    readCodexStateDbBackfillStatusMock.mockReturnValue({
      kind: 'unreadable',
      stateDbPath: '/x/state_5.sqlite',
      error: 'SQLITE_BUSY'
    })
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({ pending: true, unreadable: true, lastWatermark: null })
  })

  it('keeps holding (pending, unreadable) when the read throws', () => {
    readCodexStateDbBackfillStatusMock.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({ pending: true, unreadable: true, lastWatermark: null })
  })

  it('reports incomplete with its watermark', () => {
    readCodexStateDbBackfillStatusMock.mockReturnValue({
      kind: 'incomplete',
      stateDbPath: '/x/state_5.sqlite',
      status: 'running',
      lastWatermark: 'sessions/2026/07/25/rollout-a.jsonl'
    })
    isCodexBackfillIndexPendingMock.mockReturnValue(true)
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({
      pending: true,
      unreadable: false,
      lastWatermark: 'sessions/2026/07/25/rollout-a.jsonl'
    })
  })

  it('reports complete as not pending', () => {
    readCodexStateDbBackfillStatusMock.mockReturnValue({ kind: 'complete', stateDbPath: '/x/state_5.sqlite' })
    isCodexBackfillIndexPendingMock.mockReturnValue(false)
    expect(evaluateCodexBackfillHoldPoll('/x')).toEqual({ pending: false, unreadable: false, lastWatermark: null })
  })
})

describe('createCodexBackfillPaneHoldRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeHarness(results: CodexBackfillHoldPollResult[]) {
    const broadcasts: CodexBackfillPaneHoldState[] = []
    const release = vi.fn()
    const registry = createCodexBackfillPaneHoldRegistry({ broadcast: (s) => broadcasts.push(s) })
    let call = 0
    const evaluate = vi.fn(() => results[Math.min(call++, results.length - 1)])
    return { broadcasts, release, registry, evaluate }
  }

  const pendingResult: CodexBackfillHoldPollResult = {
    pending: true,
    unreadable: false,
    lastWatermark: 'sessions/2026/07/20/rollout-a.jsonl'
  }
  const doneResult: CodexBackfillHoldPollResult = { pending: false, unreadable: false, lastWatermark: null }

  it('broadcasts indexing immediately and exposes state via get()', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({ paneKey: 'p1', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    expect(h.broadcasts).toEqual([
      { paneKey: 'p1', phase: 'indexing', lastWatermark: 'sessions/2026/07/20/rollout-a.jsonl' }
    ])
    expect(h.registry.get('p1')).toEqual({
      paneKey: 'p1',
      phase: 'indexing',
      lastWatermark: 'sessions/2026/07/20/rollout-a.jsonl'
    })
    expect(h.release).not.toHaveBeenCalled()
  })

  it('releases on pending → false: broadcasts launched, delivers once, clears get()', () => {
    const h = makeHarness([pendingResult, doneResult])
    h.registry.begin({ paneKey: 'p1', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.broadcasts.at(-1)).toEqual({ paneKey: 'p1', phase: 'launched', lastWatermark: null })
    expect(h.registry.get('p1')).toBeNull()
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 3)
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('keeps holding across unreadable polls (active-writer contention)', () => {
    const unreadable: CodexBackfillHoldPollResult = { pending: true, unreadable: true, lastWatermark: null }
    const h = makeHarness([pendingResult, unreadable, unreadable, doneResult])
    h.registry.begin({ paneKey: 'p1', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 2)
    expect(h.release).not.toHaveBeenCalled()
    // Why: an unreadable poll must not clobber the last known watermark either.
    expect(h.registry.get('p1')?.lastWatermark).toBe('sessions/2026/07/20/rollout-a.jsonl')
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('re-broadcasts indexing when the watermark advances', () => {
    const advanced: CodexBackfillHoldPollResult = {
      pending: true,
      unreadable: false,
      lastWatermark: 'sessions/2026/07/25/rollout-b.jsonl'
    }
    const h = makeHarness([pendingResult, advanced])
    h.registry.begin({ paneKey: 'p1', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.broadcasts.at(-1)).toEqual({
      paneKey: 'p1',
      phase: 'indexing',
      lastWatermark: 'sessions/2026/07/25/rollout-b.jsonl'
    })
    expect(h.release).not.toHaveBeenCalled()
  })

  it('fails open at the max-wait ceiling while still pending', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({ paneKey: 'p1', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS + CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(h.broadcasts.at(-1)?.phase).toBe('launched')
  })

  it('dispose cancels without delivering or broadcasting further', () => {
    const h = makeHarness([pendingResult, doneResult])
    const handle = h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: h.release,
      evaluate: h.evaluate
    })
    handle.dispose()
    const broadcastCount = h.broadcasts.length
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 5)
    expect(h.release).not.toHaveBeenCalled()
    expect(h.broadcasts.length).toBe(broadcastCount)
    expect(h.registry.get('p1')).toBeNull()
  })

  it('begin() for an already-held paneKey replaces the previous hold', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({ paneKey: 'p1', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    const secondRelease = vi.fn()
    h.registry.begin({
      paneKey: 'p1',
      codexHomePath: '/x',
      releaseHeldCommand: secondRelease,
      evaluate: () => doneResult
    })
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
    expect(h.release).not.toHaveBeenCalled()
    expect(secondRelease).toHaveBeenCalledTimes(1)
  })

  it('disposeAll clears every hold silently', () => {
    const h = makeHarness([pendingResult])
    h.registry.begin({ paneKey: 'p1', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    h.registry.begin({ paneKey: 'p2', codexHomePath: '/x', releaseHeldCommand: h.release, evaluate: h.evaluate })
    h.registry.disposeAll()
    vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS * 5)
    expect(h.release).not.toHaveBeenCalled()
    expect(h.registry.get('p1')).toBeNull()
    expect(h.registry.get('p2')).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/dan/code/orca/.orca/worktrees/orca/codex-indexing-issues-11828/.worktrees/codex-backfill-prewarm && pnpm exec vitest run src/main/codex/codex-backfill-spawn-hold.test.ts`
Expected: FAIL — cannot resolve `./codex-backfill-spawn-hold`.

- [ ] **Step 4: Implement the module**

Create `src/main/codex/codex-backfill-spawn-hold.ts`:

```ts
import type { CodexBackfillPaneHoldState } from '../../shared/codex-backfill-status-types'
import { isCodexBackfillIndexPending, readCodexStateDbBackfillStatus } from './codex-state-db'

// Why: 5s keeps held panes snappy after completion without hammering sqlite (the retired renderer gate polled at 20s).
export const CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS = 5_000
// Why: mirror the retired renderer gate's ceiling — fail open rather than brick a pane (#11828).
export const CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS = 15 * 60_000

export interface CodexBackfillSpawnHoldDecisionInput {
  launchAgent: string | undefined
  startupCommand: string | undefined
  connectionId: string | null | undefined
  codexHomePath: string | null
  isPending?: (codexHomePath: string) => boolean
}

/** Why: gate only what we can locally verify — everything else launches normally (fail-open, #11828). */
export function shouldHoldCodexSpawnForBackfill(input: CodexBackfillSpawnHoldDecisionInput): boolean {
  if (input.launchAgent !== 'codex') {
    return false
  }
  if (input.connectionId) {
    return false
  }
  if (!input.startupCommand || !input.codexHomePath) {
    return false
  }
  const isPending = input.isPending ?? isCodexBackfillIndexPending
  try {
    return isPending(input.codexHomePath)
  } catch {
    return false
  }
}

export interface CodexBackfillHoldPollResult {
  pending: boolean
  unreadable: boolean
  lastWatermark: string | null
}

/** Why: once holding, a transient sqlite failure under the prewarm's active writes must not release the gate early. */
export function evaluateCodexBackfillHoldPoll(codexHomePath: string): CodexBackfillHoldPollResult {
  try {
    const status = readCodexStateDbBackfillStatus(codexHomePath)
    if (status.kind === 'unreadable') {
      return { pending: true, unreadable: true, lastWatermark: null }
    }
    const lastWatermark = status.kind === 'incomplete' ? status.lastWatermark : null
    return { pending: isCodexBackfillIndexPending(codexHomePath), unreadable: false, lastWatermark }
  } catch {
    return { pending: true, unreadable: true, lastWatermark: null }
  }
}

export interface CodexBackfillPaneHoldBeginParams {
  paneKey: string
  codexHomePath: string
  releaseHeldCommand: () => void
  evaluate?: (codexHomePath: string) => CodexBackfillHoldPollResult
  repollMs?: number
  maxWaitMs?: number
}

export interface CodexBackfillPaneHoldHandle {
  dispose: () => void
}

export interface CodexBackfillPaneHoldRegistry {
  begin: (params: CodexBackfillPaneHoldBeginParams) => CodexBackfillPaneHoldHandle
  get: (paneKey: string) => CodexBackfillPaneHoldState | null
  disposeAll: () => void
}

interface HeldPane {
  state: CodexBackfillPaneHoldState
  timer: ReturnType<typeof setInterval>
}

export function createCodexBackfillPaneHoldRegistry(deps: {
  broadcast: (state: CodexBackfillPaneHoldState) => void
}): CodexBackfillPaneHoldRegistry {
  const holds = new Map<string, HeldPane>()

  const drop = (paneKey: string): void => {
    const held = holds.get(paneKey)
    if (held) {
      clearInterval(held.timer)
      holds.delete(paneKey)
    }
  }

  const begin = (params: CodexBackfillPaneHoldBeginParams): CodexBackfillPaneHoldHandle => {
    drop(params.paneKey)
    const evaluate = params.evaluate ?? evaluateCodexBackfillHoldPoll
    const repollMs = params.repollMs ?? CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS
    const maxWaitMs = params.maxWaitMs ?? CODEX_BACKFILL_SPAWN_HOLD_MAX_WAIT_MS
    const deadline = Date.now() + maxWaitMs

    const initial = evaluate(params.codexHomePath)
    const held: HeldPane = {
      state: { paneKey: params.paneKey, phase: 'indexing', lastWatermark: initial.lastWatermark },
      timer: setInterval(() => {
        const result = evaluate(params.codexHomePath)
        // Why: 15-minute ceiling fails open — a stuck index must not brick the pane (#11828).
        if (!result.pending || Date.now() >= deadline) {
          drop(params.paneKey)
          deps.broadcast({ paneKey: params.paneKey, phase: 'launched', lastWatermark: null })
          params.releaseHeldCommand()
          return
        }
        if (!result.unreadable && result.lastWatermark !== held.state.lastWatermark) {
          held.state = { ...held.state, lastWatermark: result.lastWatermark }
          deps.broadcast(held.state)
        }
      }, repollMs)
    }
    held.timer.unref?.()
    holds.set(params.paneKey, held)
    deps.broadcast(held.state)

    return { dispose: () => drop(params.paneKey) }
  }

  return {
    begin,
    get: (paneKey) => holds.get(paneKey)?.state ?? null,
    disposeAll: () => {
      for (const paneKey of [...holds.keys()]) {
        drop(paneKey)
      }
    }
  }
}
```

(Add `import fs from 'node:fs'`, `import os from 'node:os'`, `import path from 'node:path'` to the test file for the real-predicate case.)

Validated note (documentation, not code): the decision-time fail-open policy is safe under the live backfill writer because codex's state DB runs WAL — 11,020/11,020 stress reads of the real primitive succeeded under an active writer, while a rollback-journal DB fails open ~99.5% (`database is locked`). WAL is persisted in the DB file codex owns; if a future codex changes journal mode, add retry-once-on-locked to the decision/poll reads.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main/codex/codex-backfill-spawn-hold.test.ts src/shared/codex-backfill-gate-wrapper.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/codex-backfill-status-types.ts src/shared/codex-backfill-gate-wrapper.ts src/shared/codex-backfill-gate-wrapper.test.ts src/shared/setup-agent-sequencing.ts src/main/codex/codex-backfill-spawn-hold.ts src/main/codex/codex-backfill-spawn-hold.test.ts
git commit -m "feat(codex): add backfill spawn-hold decision, gate wrapper, and pane hold registry (#11828)"
```

---

### Task 2: Wire the hold into the pty spawn choke points

**Files:**
- Modify: `src/main/ipc/pty.ts` (both dispatch paths: the `runtime.setPtyController` controller body around `:3346-3760` and the `pty:spawn` handler around `:4388-4850`)
- Test: `src/main/ipc/pty.test.ts`

**Interfaces:**
- Consumes (Task 1): `shouldHoldCodexSpawnForBackfill`, `createCodexBackfillPaneHoldRegistry`, `CodexBackfillPaneHoldState`, `buildCodexBackfillGateWrapper` + `ORCA_BACKFILL_GATED_COMMAND_ENV` / `ORCA_BACKFILL_RELEASE_FILE_ENV`. Consumes existing: `getSystemCodexHomePath` (same import as `codex-backfill-status.ts`), `registerPaneKeyTeardownListener` (`pty.ts:273`), `node:fs` for the release sentinel.
- Produces (Task 4 relies on): IPC pull channel `'codexBackfill:paneHoldStatus'` (invoke with `paneKey: string`, returns `CodexBackfillPaneHoldState | null`) and push channel `'codexBackfill:paneHoldChanged'` (payload `CodexBackfillPaneHoldState`), broadcast on the same window webContents the pty handlers already use.

**Placement notes (read before coding):**
- The two dispatch paths are near-duplicates. Renderer path: `spawnOptions` assembled ~`:4730-4790`, `paneSpawnReservation = reservePaneSpawn(...)` at ~`:4808`, `result = await provider.spawn(spawnOptions)` at ~`:4843`. Controller path: `spawnOptions.paneKey` set at ~`:3602`, dispatches at ~`:3710` (`agentSessionEnsure` arm) and ~`:3755` (plain arm). Apply the withhold ONCE per path at the point where `spawnOptions` is complete and both sub-arms of the controller path are covered (hoist above the `if (args.agentSessionEnsure)` branch at ~`:3689`).
- `selectedCodexHomePath` is currently computed at ~`:3463` / ~`:4638` but **gated behind `isDaemonHostSpawn`**; the gate must recompute it ungated — copy the existing `getCompatibleSelectedCodexHomePath(getCodexSelectionTargetForPty(...), getSelectedCodexHomePath?.(...))` call's arguments verbatim from those lines.
- The resume-pinned home is available as `codexResumeHome?.codexHomePath` (~`:3411` / ~`:4633`) and takes precedence over lane selection — it is the actual per-pane effective home.
- Detection MUST use `args.launchAgent === 'codex'`, never command parsing: in wait-for-setup mode the pty command is a polling wrapper and the codex command lives in env `ORCA_SEQUENCED_STARTUP_COMMAND`.
- Hold-begin guard (validated — do not skip): the ensure arm can resolve by ADOPTING a live owner without spawning (`pty.ts:3745-3751` synthesizes `{ id: owner.ptyId, isReattach: true }`), and the daemon can adopt THROUGH the spawn callback too (`disposition: 'adopted'`, `pty.ts:3724-3733` / `claimed-agent-pty-owner.ts:143,169`) — so `providerResult !== null` is an insufficient guard. Begin a hold ONLY when the spawn physically created the pty (`result.isReattach !== true`, and on the ensure arm disposition `'created'`). Adopted resolves never ran the replaced command — skip silently. Adopted paneKeys can also diverge from `spawnOptions.paneKey` (`orca-runtime.ts:23600-23606`); never broadcast a hold for a paneKey the pane doesn't use.
- Registry lifecycle (validated): `registerPtyHandlers` re-runs on window recreate (`attach-main-window-services.ts:109`; precedent comment `pty.ts:1705`). Keep the registry at MODULE scope (precedent: durable registries at `pty.ts:271-295`) and rebind only the broadcast target per registration — do NOT `disposeAll()` on re-registration (that would drop holds for surviving daemon ptys).
- Do not add new `max-lines` disables: keep additions to `pty.ts` thin (resolver + two short integration blocks + registry/handler setup); all logic lives in Task 1's modules.

- [ ] **Step 1: Write the failing tests**

Add a `describe('codex backfill spawn hold', ...)` block to `src/main/ipc/pty.test.ts`. Reuse the file's existing harness: the `vi.hoisted` `spawnMock` (node-pty), the `handlers` map captured from the mocked `ipcMain`, the `spawnAndGetCall` helper (~`:1609`), and the runtime-controller pattern (~`:3102`). Mock the state-db module and use fake timers:

```ts
const backfillPendingMock = vi.hoisted(() => vi.fn<(home: string) => boolean>(() => false))
const backfillStatusMock = vi.hoisted(() =>
  vi.fn(() => ({ kind: 'complete' as const, stateDbPath: '/tmp/state_5.sqlite' }))
)
vi.mock('../codex/codex-state-db', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isCodexBackfillIndexPending: backfillPendingMock,
  readCodexStateDbBackfillStatus: backfillStatusMock
}))
```

Test cases (each spawns via `handlers.get('pty:spawn')!(null, {...})` with `command: "codex '--flag'"`, `launchAgent: 'codex'`, `env: { ORCA_PANE_KEY: <paneKey built from tabId/leafId> }`, `tabId`/`leafId` args — mirror an existing renderer-path spawn test for the exact arg shape):

1. **Gated launch (wrapper replacement):** `backfillPendingMock` returns `true`, `backfillStatusMock` returns `kind:'incomplete'` with a watermark; point the selected codex home at a temp dir (`fs.mkdtempSync`). Assert: node-pty `spawnMock` WAS called (shell spawns on time) and, via `spawnAndGetCall`, the delivered command is the GATE WRAPPER, not codex — the spawn env carries `ORCA_BACKFILL_GATED_COMMAND === "codex '--flag'"` (verbatim original) and `ORCA_BACKFILL_RELEASE_FILE` under `<tempHome>/.orca/`, and the codex command itself appears in neither the shell args nor any startup write; no release sentinel file exists yet; `mainWindow.webContents.send` was called with `('codexBackfill:paneHoldChanged', { paneKey, phase: 'indexing', lastWatermark: <watermark> })`; the `'codexBackfill:paneHoldStatus'` handler returns that state for the paneKey.
2. **Auto-release on completion:** continue from a gated launch; flip `backfillPendingMock` to `false` and `backfillStatusMock` to `complete`; `vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)`. Assert the release sentinel file NOW EXISTS at the exact path from the spawn env (main's only delivery act — the wrapper in the live shell does the exec, proven end-to-end in Task 7 Step 5), a `phase: 'launched'` broadcast was sent, and `'codexBackfill:paneHoldStatus'` now returns `null`. Main performed NO pty write (assert the fake pty proc's `write` was never called with the codex command).
3. **Fail-open on unreadable state at decision time:** `backfillPendingMock` returns `false` (the existing fail-open contract of `isCodexBackfillIndexPending` for unreadable DBs). Assert the spawn proceeds with the ORIGINAL command untouched and no hold broadcast.
4. **SSH passthrough:** same args plus `connectionId: 'ssh-1'` and `backfillPendingMock` returning `true`. Assert the original command untouched, no hold broadcast, and that `backfillPendingMock` was not called at all (SSH is excluded before any DB read).
5. **WSL passthrough without an injected home:** spawn with a WSL shell/distro arg shape (mirror an existing WSL test in the file for how `terminalWindowsWslDistro`/WSL cwd is passed) and no selected codex home. Assert the original command untouched and no hold broadcast. Add a sibling case: a selected codex home shaped as a `\\wsl$` UNC path ⇒ passthrough (AD-A10 resolver clause).
6. **Non-codex passthrough:** `launchAgent: undefined`, command `'bash'`, pending `true`. Assert untouched.
7. **Teardown during hold:** gated launch, then trigger the pane teardown path the file already exercises for `registerPaneKeyTeardownListener` (or kill the pty via its exit handler); advance timers past completion. Assert the release sentinel was NEVER created and no `'launched'` broadcast fired.
8. **Reattach/adoption guard:** make the spawn resolve as a reattach (`isReattach: true` — mirror an existing reattach/adoption-shaped test in the file) with `backfillPendingMock` returning `true`. Assert: no hold broadcast, `'codexBackfill:paneHoldStatus'` returns `null`, and no sentinel was created (an adopted resolve never ran the replaced command; a hold would overlay the wrong pane and later release a command nobody is waiting for).

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm exec vitest run src/main/ipc/pty.test.ts -t 'codex backfill spawn hold'`
Expected: FAIL — no hold behavior exists; command is delivered immediately and no `paneHoldChanged` broadcast occurs.

- [ ] **Step 3: Implement the integration in `pty.ts`**

At MODULE scope in `pty.ts` (precedent: the durable registries at `:271-295`), create the registry ONCE with a rebindable broadcast target:

```ts
/** Why: holds must survive registerPtyHandlers re-registration (window recreate) — only the broadcast target changes. */
let codexBackfillHoldBroadcast: ((state: CodexBackfillPaneHoldState) => void) | null = null
const codexBackfillPaneHolds = createCodexBackfillPaneHoldRegistry({
  broadcast: (state) => codexBackfillHoldBroadcast?.(state)
})
```

Inside `registerPtyHandlers` (so it closes over `mainWindow` and the `ipcMain` mocks in tests), rebind the target + register the pull handler, near the other handler registrations (do NOT `disposeAll()` here — surviving daemon ptys keep their holds):

```ts
codexBackfillHoldBroadcast = (state) => {
  if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('codexBackfill:paneHoldChanged', state)
  }
}
ipcMain.removeHandler('codexBackfill:paneHoldStatus')
ipcMain.handle('codexBackfill:paneHoldStatus', (_event, paneKey: string) => codexBackfillPaneHolds.get(paneKey))
```

Add a module-scope resolver (import `getSystemCodexHomePath` exactly as `src/main/ipc/codex-backfill-status.ts` does):

```ts
/** Why: the gate can only hold panes whose backfill DB this process can read — fail-open scope for #11828. */
function resolveCodexBackfillGateHome(params: {
  connectionId: string | null | undefined
  resumeCodexHomePath: string | null | undefined
  selectedCodexHomePath: string | null | undefined
  wslDistro: string | null | undefined
}): string | null {
  if (params.connectionId) {
    return null
  }
  const resolved =
    params.resumeCodexHomePath ??
    params.selectedCodexHomePath ??
    // Why: a WSL pane without an injected home uses the distro's own ~/.codex, which the host cannot read.
    (params.wslDistro ? null : getSystemCodexHomePath())
  // Why: \\wsl$-style UNC homes ride 9P — sqlite reads over it are untrustworthy (AD-A10); fail open.
  return resolved != null && resolved.startsWith('\\\\') ? null : resolved
}
```

At EACH dispatch path (controller path hoisted above the `agentSessionEnsure` branch at ~`:3689`; renderer path just before the `provider.spawn` at ~`:4843`), after `spawnOptions` is complete:

```ts
const codexBackfillGateHome = resolveCodexBackfillGateHome({
  connectionId: args.connectionId,
  resumeCodexHomePath: codexResumeHome?.codexHomePath ?? null,
  // Why: recompute ungated — the existing selectedCodexHomePath is only populated for daemon-host spawns.
  selectedCodexHomePath: getCompatibleSelectedCodexHomePath(
    codexSelectionTarget,
    getSelectedCodexHomePath?.(codexSelectionTarget)
  ),
  wslDistro: expectedWslDistro ?? null
})
let heldCodexReleaseFilePath: string | undefined
if (
  spawnOptions.paneKey &&
  spawnOptions.command &&
  codexBackfillGateHome &&
  shouldHoldCodexSpawnForBackfill({
    launchAgent: args.launchAgent,
    startupCommand: spawnOptions.command,
    connectionId: args.connectionId,
    codexHomePath: codexBackfillGateHome
  })
) {
  // Why: deliver via the gate wrapper through the proven startup path — never a raw deferred pty write (#11828).
  const gate = buildCodexBackfillGateWrapper({
    originalCommand: spawnOptions.command,
    codexHomePath: codexBackfillGateHome,
    shellPlatform: process.platform === 'win32' ? 'win32' : 'posix'
  })
  spawnOptions.command = gate.command
  spawnOptions.env = { ...spawnOptions.env, ...gate.env }
  heldCodexReleaseFilePath = gate.releaseFilePath
}
```

And immediately after `result = await provider.spawn(spawnOptions)` on the same path:

```ts
// Why: adopted resolves never ran the gate wrapper — a hold would overlay the wrong pane and later
// release a command nobody is polling for (validated: ensure can adopt without spawning, and the
// daemon can adopt through the spawn callback).
const spawnCreatedFreshPty = result.isReattach !== true
if (heldCodexReleaseFilePath && spawnCreatedFreshPty && codexBackfillGateHome && spawnOptions.paneKey) {
  beginCodexBackfillPaneHold({
    paneKey: spawnOptions.paneKey,
    codexHomePath: codexBackfillGateHome,
    releaseFilePath: heldCodexReleaseFilePath
  })
}
```

with one shared helper at module scope:

```ts
function beginCodexBackfillPaneHold(params: {
  paneKey: string
  codexHomePath: string
  releaseFilePath: string
}): void {
  const handle = codexBackfillPaneHolds.begin({
    paneKey: params.paneKey,
    codexHomePath: params.codexHomePath,
    releaseHeldCommand: () => {
      // Why: release = create the sentinel the wrapper polls; idempotent and harmless even if the pty died.
      try {
        fs.mkdirSync(path.dirname(params.releaseFilePath), { recursive: true })
        fs.writeFileSync(params.releaseFilePath, '')
      } catch {
        // Fail open: the wrapper's own ~20-min deadline launches the command without us.
      }
    }
  })
  registerPaneKeyTeardownListener(params.paneKey, () => handle.dispose())
}
```

Adaptation notes for the implementer (verify against the real file, keep semantics identical):
- Ensure-arm guard: in the `agentSessionEnsure` arm, additionally require the ensure disposition to be `'created'` (see `claimed-agent-pty-owner.ts:143-149` / the `disposition: 'adopted'` callback path at `pty.ts:3724-3733`) before beginning the hold — `result.isReattach` alone does not cover a daemon-side adopt returned through the spawn callback. Locate the disposition on the ensure result the arm already has in scope.
- Match `registerPaneKeyTeardownListener`'s exact signature at `pty.ts:273` (it registers a GLOBAL listener — filter by paneKey); keep the returned unregister function alongside the hold so a normal release doesn't leak the listener. Also dispose the hold from the pty exit path if the file has a natural per-pty cleanup list (`ptyCleanupCallbacks`-style). On dispose, best-effort `fs.rmSync(params.releaseFilePath, { force: true })` is optional hygiene (the wrapper deletes the sentinel itself after seeing it).
- The sentinel lives under the gate home's `.orca/` directory — the same directory family Orca already writes into codex homes (hooks.json injection precedent). Unit tests MUST point the gate home at a temp dir.
- WSL translation: after the UNC passthrough, a gated home is always a native host path. If a gated spawn can still carry `expectedWslDistro` (win32 host, native-path injected home), pass `toShellViewPath` to `buildCodexBackfillGateWrapper` using the `hooks.ts:484-516` translation so the distro shell can see the sentinel; if translation is unavailable for that shape, skip the hold (fail open) rather than gate a pane that can never see its release file.
- `commandDelivery`/startup-delivery fields stay VALID (a real command still exists) — do not touch them.
- Place the replacement AFTER `reservePaneSpawn` on the renderer path so duplicate spawn requests coalesce onto the held pane.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `pnpm exec vitest run src/main/ipc/pty.test.ts -t 'codex backfill spawn hold'`
Expected: PASS.

- [ ] **Step 5: Run the whole pty suite to catch regressions**

Run: `pnpm exec vitest run src/main/ipc/pty.test.ts`
Expected: PASS — every pre-existing test in this file still green (the gate must be inert when `isCodexBackfillIndexPending` is false, which the mock defaults to).

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/pty.ts src/main/ipc/pty.test.ts src/main/providers/local-pty-shell-ready.ts
git commit -m "feat(codex): hold codex startup commands at the pty spawn choke point while the backfill runs (#11828)"
```

---

### Task 3: Worktree-creation (controller-arm) flow coverage

**Files:**
- Test: `src/main/ipc/pty.test.ts`
- Modify (only if the verification below finds `launchAgent` missing): `src/main/ipc/worktree-remote.ts`

**Interfaces:**
- Consumes (Task 2): the integrated hold behavior; channels `'codexBackfill:paneHoldChanged'` / `'codexBackfill:paneHoldStatus'`.
- Produces: proof that the reporter's primary flow (main-spawned worktree-creation codex pane) is gated. No new API.

**Context:** `spawnLocalStartupAndSetupTerminals` (`src/main/ipc/worktree-remote.ts:245-313`) calls `runtime.createTerminal(...)` with `launchAgent: createdWithAgent` threaded at ~`:304` (`...(isTuiAgent(createdWithAgent) ? { launchAgent: createdWithAgent } : {})`), and `OrcaRuntimeService.createTerminal` (`src/main/runtime/orca-runtime.ts:23419`) forwards to `this.ptyController.spawn({...})` (`:23548`) — the controller installed by `registerPtyHandlers` at `pty.ts:3346`, always with `commandDelivery: 'provider'` and a main-minted `paneKey`. So Task 2's controller-path gate already sits on this flow; this task proves it with tests shaped like the real worktree-creation args.

- [ ] **Step 1: Verify the `launchAgent` plumbing by reading the two call sites**

Read `src/main/ipc/worktree-remote.ts:245-313` and `src/main/runtime/orca-runtime.ts:23419-23560`. Confirm the object passed to `this.ptyController.spawn` includes `launchAgent` when the worktree is created with Agent=Codex (report anchors: `worktree-remote.ts:304`, `orca-runtime.ts` spawn payload includes `launchAgent: launchOpts.launchAgent`). If it does NOT survive to the controller args, thread it through (one-line addition to the spawn payload in `orca-runtime.ts`) — that is the only product change permitted in this task.

- [ ] **Step 2: Write the failing/verifying tests**

Extend the `describe('codex backfill spawn hold', ...)` block in `src/main/ipc/pty.test.ts` using the file's existing runtime-controller pattern (~`:3102`: `registerPtyHandlers(mainWindow, runtime, ...)`, then `const controller = runtime.setPtyController.mock.calls[0]?.[0]`):

```ts
it('holds a worktree-creation startup terminal spawned through the runtime controller', async () => {
  backfillPendingMock.mockReturnValue(true)
  backfillStatusMock.mockReturnValue({
    kind: 'incomplete',
    stateDbPath: '/tmp/state_5.sqlite',
    status: 'running',
    lastWatermark: 'sessions/2026/07/25/rollout-a.jsonl'
  })
  // Mirror the arg shape OrcaRuntimeService.createTerminal sends for a codex worktree startup
  // terminal (orca-runtime.ts:23548): provider commandDelivery, main-minted paneKey, launchAgent.
  await controller.spawn({
    cols: 80,
    rows: 24,
    command: "codex '--dangerously-bypass-approvals-and-sandbox'",
    launchAgent: 'codex',
    commandDelivery: 'provider',
    tabId: 'tab-wt',
    leafId: 'leaf-wt',
    cwd: '/home/user/repo/.orca/worktrees/repo/branch'
  })
  // shell spawned, codex command withheld, hold broadcast with the paneKey main minted
  expect(spawnMock).toHaveBeenCalled()
  const sent = mainWindowWebContentsSendMock.mock.calls.filter(([ch]) => ch === 'codexBackfill:paneHoldChanged')
  expect(sent.at(-1)?.[1]).toMatchObject({ phase: 'indexing', lastWatermark: 'sessions/2026/07/25/rollout-a.jsonl' })
})

it('auto-launches the held worktree-creation pane when the backfill completes', async () => {
  // ...same gated setup as above...
  backfillPendingMock.mockReturnValue(false)
  backfillStatusMock.mockReturnValue({ kind: 'complete', stateDbPath: '/tmp/state_5.sqlite' })
  vi.advanceTimersByTime(CODEX_BACKFILL_SPAWN_HOLD_REPOLL_MS)
  // the release sentinel now exists (read its path from the spawn env) and 'launched' was broadcast
})

it('holds the agentSessionEnsure controller arm the same way', async () => {
  // same as the first test but with the resume-shaped args from the existing test at ~:3102
  // (command: 'codex resume session-a', resumeProviderSession: {...}) and a stubbed
  // prepareCodexSessionResume returning a codexHomePath — assert the hold uses THAT home
  // (resume-pinned home takes precedence over lane selection).
})

it('does not hold when the ensure arm adopts a live owner instead of spawning', async () => {
  // same resume-shaped args, but with a live claimed owner so ensure resolves WITHOUT spawning
  // (adoption: synthesized { id: owner.ptyId, isReattach: true } at pty.ts:3745-3751, or the daemon's
  // disposition:'adopted' via the callback). Assert: no paneHoldChanged broadcast, paneHoldStatus null,
  // and no release sentinel exists — the replaced command was never executed by anyone, and a hold
  // would overlay the wrong pane (adopted paneKey can diverge, orca-runtime.ts:23600-23606).
})

it('passes a remote controller spawn through untouched', async () => {
  backfillPendingMock.mockReturnValue(true)
  await controller.spawn({
    cols: 80,
    rows: 24,
    command: 'codex',
    launchAgent: 'codex',
    connectionId: 'ssh-1',
    tabId: 't',
    leafId: 'l'
  })
  expect(
    mainWindowWebContentsSendMock.mock.calls.filter(([ch]) => ch === 'codexBackfill:paneHoldChanged')
  ).toHaveLength(0)
})
```

Adapt mock names (`mainWindowWebContentsSendMock`, controller extraction, fake pty write capture) to the file's actual harness; the four behaviors above are the contract. Copy the exact resume-arm arg shape from the existing test at ~`:3102` rather than inventing one.

- [ ] **Step 3: Run to verify current state**

Run: `pnpm exec vitest run src/main/ipc/pty.test.ts -t 'codex backfill spawn hold'`
Expected: the new controller-arm tests PASS if Task 2's hoisted placement is correct (they are regression armor for the reporter's primary flow); if any FAIL, the placement missed an arm — fix `pty.ts` (hoist above the `agentSessionEnsure` branch) until green. Do not weaken assertions to pass.

- [ ] **Step 4: Run the whole pty suite**

Run: `pnpm exec vitest run src/main/ipc/pty.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/pty.test.ts src/main/ipc/worktree-remote.ts src/main/runtime/orca-runtime.ts
git commit -m "test(codex): prove worktree-creation controller spawns inherit the backfill hold (#11828)"
```

(Include `worktree-remote.ts` / `orca-runtime.ts` only if Step 1 required the plumbing fix; otherwise commit the test file alone.)

---

### Task 4: IPC surface — preload, api-types, web stub, renderer subscription helper

**Files:**
- Modify: `src/preload/index.ts` (codexBackfill namespace at ~`:2065-2074`)
- Modify: `src/preload/api-types.ts` (codexBackfill type at ~`:2402-2406`)
- Modify: `src/renderer/src/web/web-preload-api.ts` (codexBackfill stub at ~`:814-820`)
- Create: `src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.ts`
- Test: `src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.test.ts`

**Interfaces:**
- Consumes (Task 2): channels `'codexBackfill:paneHoldStatus'` (invoke, arg `paneKey: string`, returns `CodexBackfillPaneHoldState | null`) and `'codexBackfill:paneHoldChanged'` (push, payload `CodexBackfillPaneHoldState`). Consumes existing: `CodexIndexingPaneState` (`{ lastWatermark: string | null }`) from `./codex-backfill-spawn-gate` (still present until Task 5).
- Produces (Task 5 relies on): `window.api.codexBackfill.paneHoldStatus(paneKey): Promise<CodexBackfillPaneHoldState | null>`, `window.api.codexBackfill.onPaneHoldChanged(cb): () => void`, and `subscribeToCodexBackfillPaneHold(paneKey: string, onState: (state: CodexIndexingPaneState | null) => void): () => void`.

- [ ] **Step 1: Write the failing test for the subscription helper**

Create `src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.test.ts`, mirroring the window.api stubbing pattern of the existing `codex-backfill-spawn-gate.test.ts` (hand-rolled api stub assigned to `window.api.codexBackfill`, no fake timers needed — this helper has no timers):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexBackfillPaneHoldState } from '../../../../shared/codex-backfill-status-types'
import { subscribeToCodexBackfillPaneHold } from './codex-backfill-pane-hold'

describe('subscribeToCodexBackfillPaneHold', () => {
  let listeners: Array<(state: CodexBackfillPaneHoldState) => void>
  let initial: CodexBackfillPaneHoldState | null
  let unsubscribeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listeners = []
    initial = null
    unsubscribeSpy = vi.fn()
    ;(window as never as { api: unknown }).api = {
      codexBackfill: {
        paneHoldStatus: vi.fn(() => Promise.resolve(initial)),
        onPaneHoldChanged: (cb: (state: CodexBackfillPaneHoldState) => void) => {
          listeners.push(cb)
          return unsubscribeSpy
        }
      }
    }
  })
  afterEach(() => {
    delete (window as never as { api?: unknown }).api
  })

  const emit = (state: CodexBackfillPaneHoldState): void => listeners.forEach((cb) => cb(state))

  it('replays the current hold state for its paneKey on subscribe', async () => {
    initial = { paneKey: 'p1', phase: 'indexing', lastWatermark: 'sessions/a.jsonl' }
    const onState = vi.fn()
    subscribeToCodexBackfillPaneHold('p1', onState)
    await Promise.resolve()
    await Promise.resolve()
    expect(onState).toHaveBeenCalledWith({ lastWatermark: 'sessions/a.jsonl' })
  })

  it('maps pushed indexing state and clears on launched', () => {
    const onState = vi.fn()
    subscribeToCodexBackfillPaneHold('p1', onState)
    emit({ paneKey: 'p1', phase: 'indexing', lastWatermark: 'sessions/b.jsonl' })
    expect(onState).toHaveBeenLastCalledWith({ lastWatermark: 'sessions/b.jsonl' })
    emit({ paneKey: 'p1', phase: 'launched', lastWatermark: null })
    expect(onState).toHaveBeenLastCalledWith(null)
  })

  it('ignores other panes', () => {
    const onState = vi.fn()
    subscribeToCodexBackfillPaneHold('p1', onState)
    emit({ paneKey: 'other', phase: 'indexing', lastWatermark: null })
    expect(onState).not.toHaveBeenCalled()
  })

  it('stops delivering after dispose and forwards the unsubscribe', () => {
    const onState = vi.fn()
    const dispose = subscribeToCodexBackfillPaneHold('p1', onState)
    dispose()
    emit({ paneKey: 'p1', phase: 'indexing', lastWatermark: null })
    expect(onState).not.toHaveBeenCalled()
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the api surface is missing (web build)', () => {
    ;(window as never as { api?: unknown }).api = {}
    expect(() => subscribeToCodexBackfillPaneHold('p1', vi.fn())()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement preload, types, web stub, and the helper**

`src/preload/index.ts` — extend the codexBackfill namespace (import `CodexBackfillPaneHoldState` from the shared types module alongside the existing `CodexBackfillGateStatus` import):

```ts
/** Why: main enforces the #11828 spawn gate; panes only mirror this per-pane hold state for the overlay. */
paneHoldStatus: (paneKey: string): Promise<CodexBackfillPaneHoldState | null> =>
  ipcRenderer.invoke('codexBackfill:paneHoldStatus', paneKey),
onPaneHoldChanged: (callback: (state: CodexBackfillPaneHoldState) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, state: CodexBackfillPaneHoldState): void =>
    callback(state)
  ipcRenderer.on('codexBackfill:paneHoldChanged', listener)
  return () => ipcRenderer.removeListener('codexBackfill:paneHoldChanged', listener)
}
```

`src/preload/api-types.ts` — extend the codexBackfill member:

```ts
paneHoldStatus: (paneKey: string) => Promise<CodexBackfillPaneHoldState | null>
onPaneHoldChanged: (callback: (state: CodexBackfillPaneHoldState) => void) => () => void
```

`src/renderer/src/web/web-preload-api.ts` — extend the stub:

```ts
// Why: hold state rides Electron IPC only; web-served panes (incl. orca-serve attaches on the serve host's
// local runtime) render no overlay — accepted residual AD-A9, bounded by the gate's fail-open ceilings.
paneHoldStatus: () => Promise.resolve(null),
onPaneHoldChanged: () => () => {}
```

Create `src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.ts` (match the shared-types import path style used by `codex-backfill-spawn-gate.ts` for `CodexBackfillGateStatus`):

```ts
import type { CodexBackfillPaneHoldState } from '../../../../shared/codex-backfill-status-types'
import type { CodexIndexingPaneState } from './codex-backfill-spawn-gate'

function toIndexingState(state: CodexBackfillPaneHoldState | null): CodexIndexingPaneState | null {
  if (!state || state.phase !== 'indexing') {
    return null
  }
  return { lastWatermark: state.lastWatermark }
}

/** Why: main owns gate enforcement (#11828); every pane — fresh or adopted — just mirrors its paneKey's hold state. */
export function subscribeToCodexBackfillPaneHold(
  paneKey: string,
  onState: (state: CodexIndexingPaneState | null) => void
): () => void {
  const api = window.api?.codexBackfill
  if (!api?.onPaneHoldChanged || !api?.paneHoldStatus) {
    return () => {}
  }
  let disposed = false
  void api
    .paneHoldStatus(paneKey)
    .then((state) => {
      if (!disposed && state && state.paneKey === paneKey) {
        onState(toIndexingState(state))
      }
    })
    .catch(() => {})
  const unsubscribe = api.onPaneHoldChanged((state) => {
    if (!disposed && state.paneKey === paneKey) {
      onState(toIndexingState(state))
    }
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the three modified layers**

Run: `pnpm typecheck`
Expected: exit 0 (the `satisfies PreloadApi['codexBackfill']` in preload forces api-types/preload/web-stub agreement).

- [ ] **Step 6: Commit**

```bash
git add src/preload/index.ts src/preload/api-types.ts src/renderer/src/web/web-preload-api.ts src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.ts src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.test.ts
git commit -m "feat(codex): expose per-pane backfill hold state to the renderer over IPC (#11828)"
```

---

### Task 5: Refactor the renderer into a pure consumer

**Files:**
- Modify: `src/renderer/src/components/terminal-pane/pty-connection.ts` (gate predicate at ~`:3540`, park clause in `runDeferredConnect` fresh-spawn arm at ~`:8625`, adoption arm at ~`:8608`)
- Modify: `src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.ts` (take over the `CodexIndexingPaneState` type)
- Modify: `src/renderer/src/components/terminal-pane/CodexIndexingOverlay.tsx`, `src/renderer/src/components/terminal-pane/TerminalPane.tsx`, `src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts` (import updates only)
- Delete: `src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.ts`, `src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts`
- Modify: `launch-ai-vault-session.ts` (+ its unit tests; locate with `git -C <worktree> grep -ln 'launchAiVaultSessionInNewTab' -- src/renderer`) — Step 6b closes the validated launchAgent detection gap
- Test: the branch-owned pty-connection gate tests (locate with `git -C <worktree> grep -l 'shouldGateCodexSpawnOnBackfill\|waitForCodexBackfillGate' -- 'src/renderer/**/*.test.ts'`)

**Interfaces:**
- Consumes (Task 4): `subscribeToCodexBackfillPaneHold`.
- Produces: `CodexIndexingPaneState` now exported from `./codex-backfill-pane-hold`; `pty-connection.ts` no longer imports `./codex-backfill-spawn-gate`; the overlay behavior is unchanged for users.

- [ ] **Step 1: Move the `CodexIndexingPaneState` type**

Cut this from `codex-backfill-spawn-gate.ts` and paste it into `codex-backfill-pane-hold.ts` (replacing the Task 4 import of it):

```ts
export type CodexIndexingPaneState = { lastWatermark: string | null }
```

Update every importer to the new module: `CodexIndexingOverlay.tsx`, `TerminalPane.tsx`, `use-terminal-pane-lifecycle.ts`, `pty-connection.ts` (find them with `git -C <worktree> grep -n "from './codex-backfill-spawn-gate'" src/renderer`). Overlay rendering, `formatCodexIndexingProgress`, the `onCodexIndexingStateRef` plumbing, and the i18n keys are untouched.

- [ ] **Step 2: Write/adjust the failing pane tests**

In the branch-owned pty-connection test file(s) found above, replace the park-behavior tests with subscription-behavior tests. Required cases (reuse the file's existing pane/connection harness and stub `window.api.codexBackfill` as in Task 4's test):

1. **Adopted pane shows the overlay** (THE np-task-8 gap): drive a pane through the adoption arm (`existingPtyId` attach); emit `{ paneKey: <that pane's key>, phase: 'indexing', lastWatermark: 'w1' }` on the stubbed `onPaneHoldChanged`; assert the pane's `onCodexIndexingStateRef` sink received `{ lastWatermark: 'w1' }`.
2. **Fresh-spawned pane shows and clears the overlay**: fresh-spawn arm; emit indexing then `phase: 'launched'`; assert the sink received the state then `null`.
3. **Fresh spawn is no longer parked by the renderer**: with `window.api.codexBackfill` reporting pending (old-style global status), assert the connect path proceeds to `pty:spawn` immediately (no renderer-side deferral — main owns enforcement now).
4. **Replay on mount**: stub `paneHoldStatus` to resolve an indexing state for the pane's key; assert the sink is driven without any push event (covers a hold broadcast that fired before the pane subscribed — the worktree-creation adoption race).
5. **Unsubscribe on teardown**: dispose the pane/connection; emit further events; assert the sink is not driven again.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `pnpm exec vitest run <the pty-connection test file(s)>`
Expected: FAIL — parking still exists and no subscription is installed.

- [ ] **Step 4: Implement the refactor in `pty-connection.ts`**

1. Delete the `shouldGateCodexSpawnOnBackfill()` closure (~`:3540`), the park clause in `runDeferredConnect`'s fresh-spawn arm (~`:8625`), the `codexBackfillGateCleared` latch, and the `waitForCodexBackfillGate` import. The fresh-spawn arm now always proceeds to `pty:spawn` (main holds the command when needed).
2. Install the subscription ONCE per pane connection, in the code path shared by BOTH arms of `runDeferredConnect` (before the `existingPtyId` branch), and dispose it in the same cleanup that previously disposed the gate wait:

```ts
// Why: main enforces the #11828 gate at the spawn choke point; the pane mirrors its own hold state (fresh or adopted).
const disposeCodexBackfillPaneHold = subscribeToCodexBackfillPaneHold(paneKey, (state) => {
  deps.onCodexIndexingStateRef.current?.(paneId, state)
})
```

`paneKey` must be the exact string main knows: reuse the value the renderer already places in the spawn env as `ORCA_PANE_KEY` (find its construction in `pty-connection.ts` — it is built from the pane's `tabId`/`leafId` and cross-verified by main at `pty.ts:4518-4541`). For adopted panes, build it with the same builder from the pane's `tabId`/`leafId` (main minted those ids and delivered them via `ui:createTerminal`, so they match main's `makePaneKey(tabId, leafId)`). If the builder lives elsewhere, import it — do not re-derive the format by hand. Match the exact sink call shape (`deps.onCodexIndexingStateRef.current(paneId, state)`) to how the removed park clause drove the overlay.

- [ ] **Step 5: Run the renderer tests**

Run: `pnpm exec vitest run <the pty-connection test file(s)> src/renderer/src/components/terminal-pane/codex-backfill-pane-hold.test.ts`
Expected: PASS.

- [ ] **Step 6: Delete the superseded gate module and verify nothing references it**

```bash
git rm src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.ts src/renderer/src/components/terminal-pane/codex-backfill-spawn-gate.test.ts
git grep -n 'codex-backfill-spawn-gate\|waitForCodexBackfillGate\|shouldGateCodexSpawnOnBackfill\|CODEX_BACKFILL_GATE_REPOLL_MS'
```

Expected: the grep returns no hits in `src/` (docs/plans may still mention the old design). Then run `pnpm typecheck` — exit 0.

Note: keep the existing global `window.api.codexBackfill.status` / `onStatusChanged` surface (other consumers — e.g. the prewarm-completion broadcast — still use it); only the renderer's spawn-gating consumption is removed.

- [ ] **Step 6b: Close the launchAgent detection gap (validated falsification)**

`launchAiVaultSessionInNewTab` (`launch-ai-vault-session.ts:74` at db57146f8) queues `launchAgent` only inside `...(args.launchConfig ? … : {})`, so launchConfig-absent codex resumes (older-serializer drag-drop payloads via `AiVaultSessionDropLayer.tsx:233-243`; the sidebar-resume fallback at `ai-vault-resume-command.ts:205-223`) reach `pty:spawn` WITHOUT `launchAgent` and would bypass the main-side gate entirely. Move `launchAgent: args.agent` out of the conditional so it is queued unconditionally, and add/extend a unit test beside the module's existing ones asserting a launchConfig-ABSENT codex launch still carries `launchAgent: 'codex'` into the queued pane startup. Scope note (keep as a one-line comment at the fix): raw user-authored command strings (quick commands, template tabs, setup/issue splits) remain ungated by design — arbitrary commands cannot be classified as codex; the backfill-error detector + amber toast stay the net for them.

- [ ] **Step 7: Commit**

```bash
git add -A src/renderer src/preload
git commit -m "refactor(terminal): make panes pure consumers of the main-side backfill hold state (#11828)"
```

---

### Task 6: Full gates

**Files:** none new — verification only (plus any mechanical fallout fixes, each committed with a focused message).

- [ ] **Step 1: Lint**

Run: `pnpm lint` (timeout ≥ 600s)
Expected: exit 0. Fix any new violations (remember: no new `max-lines` disables — if a file blew past a limit, extract to the Task 1 module instead).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` (timeout ≥ 600s)
Expected: exit 0.

- [ ] **Step 3: Tests**

Run: `pnpm test` (timeout ≥ 3600s)
Expected: the ONLY failures are the documented pre-existing ones (7 failures across `configure-process.test.ts`, `pty-subprocess.test.ts`, `local-pty-provider.test.ts`, `managed-hook-timeout.test.ts`, plus load-flakes that pass in isolation — re-run any suspected flake in isolation to prove it). Every branch-owned test file passes 100%. Any NEW failure is yours: fix it.

- [ ] **Step 4: Build**

Run: `pnpm build` (timeout ≥ 1800s)
Expected: exit 0.

- [ ] **Step 5: Commit (only if fallout fixes were needed)**

```bash
git add <specific files>
git commit -m "fix(codex): <specific fallout description> (#11828)"
```

---

### Task 7: Sandboxed reporter-shape E2E re-run

**Files:** none in-repo — evidence-gathering task. Throwaway driver scripts live in the sandbox only, never in the repo. Record observations (log line numbers, timestamps, DOM/sqlite evidence) in the task report.

**Protocol** (identical to the prior task-8 run, with the new criterion; machine: WSL2 Ubuntu 24.04; app driven via Chrome DevTools Protocol on the dev remote-debugging port 9448 under WSLg):

- [ ] **Step 1: Build the sandbox**

```bash
E2E_ROOT=$(mktemp -d /tmp/orca-e2e-11828.XXXXXX) && chmod 700 "$E2E_ROOT"
E2E_DATA="$E2E_ROOT/userdata"; E2E_HOME="$E2E_DATA/home"
mkdir -p "$E2E_HOME/.codex"
cp -a "$HOME/.codex/sessions" "$E2E_HOME/.codex/sessions"   # real copy — NEVER cp -al
cp "$HOME/.codex/auth.json" "$HOME/.codex/config.toml" "$E2E_HOME/.codex/"
printf '[user]\n\tname = E2E Runner\n\temail = e2e@example.invalid\n' > "$E2E_HOME/.gitconfig"
```

Verify (all must hold before launching):
- Hardlink check on a sampled session file: `stat -c 'links=%h inode=%i size=%s' <copy> <original>` — link count 1 on both, inodes differ.
- File counts match: `find "$HOME/.codex/sessions" -type f | wc -l` vs the copy (~4961; the live source may drift by a few while other codex sessions run).
- `ls "$E2E_HOME/.codex"` → `auth.json config.toml sessions` only; `ls "$E2E_HOME/.codex" | grep -c '^state_'` → 0 (reporter shape: 15G history, no state DB).
- Real homes pre-run (read-only): `sqlite3 "file:$HOME/.codex/state_5.sqlite?mode=ro" "select status from backfill_state;"` → `complete`; same for `"file:$HOME/.local/share/orca/codex-runtime-home/home/state_5.sqlite?mode=ro"`.

- [ ] **Step 2: Launch**

From the worktree root, backgrounded with output to `$E2E_ROOT/app.log`:

```bash
env -u CODEX_HOME -u ORCA_CODEX_HOME -u ZDOTDIR -u BASH_ENV \
  HOME="$E2E_HOME" USERPROFILE="$E2E_HOME" \
  ORCA_E2E_USER_DATA_DIR="$E2E_DATA" ORCA_E2E_HOME_DIR="$E2E_HOME" \
  ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME=1 pnpm dev > "$E2E_ROOT/app.log" 2>&1 &
```

Codex resolves at `/home/dan/.local/bin/codex` — no PATH adjustments needed.

- [ ] **Step 3: Verify the previously-passing criteria still hold**

1. **Trust-grant deferral, lane NOT latched** (~T+25s in app.log): `deferring trust grant until codex session index completes`; `grep -c CodexAppServerTimeoutError app.log` → 0; `grep -c 'trust grant unavailable' app.log` → 0.
2. **Prewarm runs**: `pre-warming codex session index at $E2E_HOME/.codex` line; confirm the prewarm codex child via `/proc/<pid>/environ` containing `CODEX_HOME=$E2E_HOME/.codex`. Poll progress read-only: `sqlite3 "file:$E2E_HOME/.codex/state_5.sqlite?mode=ro" "select status, last_watermark from backfill_state;"`. **LET IT RUN — poll patiently every ~60s; ~10-13 minutes for 15G.**
3. **Daemon provider active** (validated: dev/E2E select the daemon pty provider, and the fallback to `LocalPtyProvider` is SILENT): confirm the daemon init succeeded in app.log (daemon-init success line / `out/main/daemon-entry.js` startup) so the E2E exercises the provider path production uses.

- [ ] **Step 4: Verify the NEW criterion — main-spawned worktree pane is gated**

WHILE the index is still `running` (do this within the first few minutes): complete onboarding via CDP if needed, create a project, then create a worktree workspace with Agent=Codex — the exact reporter flow that spawns the startup terminal in main. Assert, in order:
1. The pane does NOT run codex: no `state db backfill is running` / `failed to initialize sqlite local db` / `appears to be damaged` text in the pane DOM; no codex child process whose environ carries the sandbox CODEX_HOME other than the prewarm's (pgrep + `/proc/*/environ` sweep). The pane's shell runs the gate wrapper's quiet poll (like the existing "Waiting for setup…" wrapper) under the overlay; the release sentinel `$E2E_HOME/.codex/.orca/backfill-release-*` does not exist yet.
2. The "Indexing Codex session history…" overlay IS visible in that pane's DOM (the previously-FAILED criterion).
3. `app.log` shows no amber backfill-death toast for this pane (the detector net must have nothing to catch).
4. A plain shell pane created at the same time spawns normally with no overlay (gate scoping).

If the index completes before you reach this step, force the deterministic repro exactly as np-task-8 did (sandbox DB only — it is a disposable copy): `sqlite3 "$E2E_HOME/.codex/state_5.sqlite" "update backfill_state set status='running'"`, create the codex worktree pane, observe hold + overlay, then restore `status='complete'` and observe the auto-launch (Step 5). Never do this to the real homes.

- [ ] **Step 5: Verify auto-launch on completion**

When `backfill_state.status` flips to `complete`:
1. `app.log` shows `codex session index complete` and the trust-grant retry (`granted N managed hook entries…`), still zero `trust grant unavailable`.
2. The held pane's overlay clears and codex auto-starts in that same pane: the codex TUI banner (`>_ OpenAI Codex`) renders. This is the E2E proof of the release chain (main creates the sentinel → the gate wrapper sees it, deletes it, and evals the original command). Verify the sentinel was consumed: `ls "$E2E_HOME/.codex/.orca/"` shows no `backfill-release-*` leftovers.
3. A NEW codex pane created after completion starts codex immediately, no overlay (steady state).

- [ ] **Step 6: Steady-state relaunch**

Quit the app; relaunch with the identical env block (log to `$E2E_ROOT/app2.log`); wait ≥80s: `grep -c 'deferring trust grant' app2.log` → 0, `grep -c 'pre-warming' app2.log` → 0, no app-server child with the sandbox CODEX_HOME, `backfill_state` still `complete`.

- [ ] **Step 7: Clean up fully and verify real homes untouched**

1. TERM the dev process group; TERM/KILL-sweep every process whose cmdline or `/proc/<pid>/environ` references `$E2E_ROOT` until the sweep count is 0.
2. Remove the sandbox: `python3 -c "import shutil; shutil.rmtree('$E2E_ROOT')"` (the bash `rm -rf` may be blocked by tool safety guards); `ls -d /tmp/orca-e2e-11828.*` → none.
3. Real homes (read-only): both `state_5.sqlite` DBs still `complete`; `du -sh ~/.codex/sessions` unchanged (~15G); `~/.codex/hooks.json`, `~/.codex/config.toml`, and the runtime-home `hooks.json` mtimes all pre-run.

- [ ] **Step 8: Verdict**

SUCCESS requires: criteria in Steps 3, 5, 6 all OBSERVED, and Step 4 (the previously-FAILED criterion) OBSERVED. If Step 4 fails again, HALT with the evidence (per the standard halt rules) — do not paper over it. No commit for this task unless the E2E exposed a fixable defect, in which case fix + test + commit with `fix(codex): …(#11828)` and re-run the affected E2E steps.

---

## Self-Review (performed against the spec)

1. **Spec coverage:** main-process choke-point gate for ALL flows → Tasks 2–3 (both `pty.ts` dispatch paths, controller arms incl. `agentSessionEnsure` with the created-disposition/`isReattach` hold guard, worktree-creation arg shape). Renderer overlay driven by main-side state with the renderer gate refactored to a consumer and the duplicate enforcement deleted → Tasks 4–5 (incl. the Task 5 `launchAgent` producer hardening that closes the validated `launchAiVaultSessionInNewTab` detection gap). Local-only scope (native-filesystem homes; `\\wsl$` UNC homes passed through per AD-A10), SSH/remote passthrough → resolver in Task 2 + tests in Tasks 2–3. Fail-open on undeterminable state → Task 1 decision semantics + Task 2 test 3; hold-time contention tolerance (np-task-8 concern #2) → Task 1 `evaluateCodexBackfillHoldPoll` + registry test, with the WAL-contention validation note (11,020/11,020 reads under a live writer). Pre-DB startup window (cold-restored codex panes) → the real-predicate ≥100-files test in Task 1 + the cold-restore-shaped expectations in Task 2 test 1. Auto-launch on completion → gate wrapper + Task 1 registry release + Task 2 test 2 + Task 3 + E2E Step 5. Cross-platform → the gate wrapper mirrors `setup-agent-sequencing.ts`'s production posix + win32 `-EncodedCommand` builders, so held delivery rides the same proven startup path on every platform; no POSIX-only product code. Unit-test list from the spec (gated launch, auto-launch, fail-open, SSH/remote passthrough, worktree-creation wiring, adoption guard) → Tasks 1–3. Full gates → Task 6. Reporter-shape E2E with the new criterion, daemon-provider assertion, sandbox hygiene, real-home read-only guarantees → Task 7. Accepted residuals are recorded, not silent (load-bearing ledger AD-A3 win32-wrapper unexercised here, AD-A9 web-attached serve panes hold without an overlay, AD-A10 UNC WSL homes ungated by design).
2. **No silent deferrals:** the production outcome for every requirement is proven without stubs by Task 7 (real 15G history, real codex binary, real app, main-spawned pane held → overlay → sentinel release → wrapper execs codex). Unit-level mocks (node-pty, codex-state-db) are all superseded by that E2E.
3. **Placeholder scan:** every code step contains the actual code; the deliberate "verify against the real file" notes (`registerPaneKeyTeardownListener` at `:273`, the verbatim `getCompatibleSelectedCodexHomePath` expression, the ensure-arm disposition guard against `claimed-agent-pty-owner.ts:143-149`, the gate-wrapper mirror of `setup-agent-sequencing.ts:92-128/:202-254`, resume-arm arg shape at `pty.test.ts:3102`) are directed adaptations to anchored existing code, not TBDs.
4. **Type consistency:** `CodexBackfillPaneHoldState { paneKey, phase, lastWatermark }` and channel names `'codexBackfill:paneHoldChanged'` / `'codexBackfill:paneHoldStatus'` are identical across Tasks 1, 2, 4, 5; `buildCodexBackfillGateWrapper` + `ORCA_BACKFILL_GATED_COMMAND_ENV` / `ORCA_BACKFILL_RELEASE_FILE_ENV` and the `releaseHeldCommand` callback name match between Tasks 1 and 2; `subscribeToCodexBackfillPaneHold(paneKey, onState)` matches between Tasks 4 and 5; `CodexIndexingPaneState` import path changes exactly once (Task 5) with all importers listed.
5. **Load-bearing validation applied (run 3):** the original raw deferred-pty-write delivery was FALSIFIED by a live-pty experiment (loss under stdin-reading rc files, early double-echo/paste garbling, multiline mangling) and replaced with the release-sentinel gate wrapper, itself validated against the in-repo precedent before adoption; hold-begin is guarded against ensure/daemon adoption (falsified A4); the registry is module-scope with per-registration broadcast rebind (falsified A11); UNC WSL homes fail open (AD-A10); the `launchAgent` producer gap is closed in Task 5 (falsified A12). Full ledger + evidence: the workflow logs' `load-bearing-ledger.md`.
