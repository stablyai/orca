# Resource Manager Unbound Session Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace renderer-only orphan inference with an explicit review flow and a main-process guarded cleanup that can terminate only freshly confirmed inactive shells.

**Architecture:** The renderer continues to compute only bound versus unbound ownership. A provider-grouped main classifier produces fail-closed process evidence, while a separate guarded kill IPC repeats that classification immediately before exact shutdown. A focused renderer coordinator refreshes daemon and store state at review and confirmation boundaries; a separate dialog renders counts and bounded outcomes.

**Tech Stack:** Electron IPC, TypeScript, React, Zustand, Vitest, happy-dom, shadcn Dialog/Button, oxlint, reliability-gate JSONC.

## Global Constraints

- Use **unbound** for renderer absence; never call it inactive or safe without main-process evidence.
- `inactive` requires provider inventory membership, `hasChildProcesses(id) === false`, and a non-null freshly confirmed foreground accepted by `isShellProcess()`.
- Active, unknown, disconnected, unsupported, and failed inspections are protected from ordinary bulk cleanup.
- Re-read current renderer bindings immediately before guarded cleanup; never chase IDs created after review.
- Keep `pty.kill` as the explicitly confirmed force path; guarded bulk cleanup uses a separate IPC.
- Do not add polling, dependencies, max-lines disables, max-lines threshold changes, local-only process inspection, or unrelated refactors.
- Preserve macOS, Linux, Windows, WSL, SSH, and headless/mobile behavior behind existing provider routing.
- Follow `docs/STYLEGUIDE.md`; use existing `Dialog`, `Button`, `LoaderCircle`, and tokenized classes.

---

### Task 1: Fail-closed provider classifier

**Files:**
- Create: `src/shared/pty-inactive-cleanup.ts`
- Create: `src/shared/pty-inactive-cleanup.test.ts`
- Create: `src/main/ipc/pty-inactive-cleanup.ts`
- Create: `src/main/ipc/pty-inactive-cleanup.test.ts`

**Interfaces:**
- Produces: `PtyCleanupSafety`, `PtyCleanupInspection`, `PtyInactiveCleanupResult`, `normalizePtyInactiveCleanupIds(value)`.
- Produces: `inspectPtyInactiveCleanupTargets(targets)` where each target is `{ id, provider }` and `provider` is the owning `IPtyProvider` or `null`.
- Consumes: `IPtyProvider.listProcesses`, `hasChildProcesses`, `confirmForegroundProcess`, and shared `isShellProcess`.

- [ ] **Step 1: Write normalization tests**

```ts
import { describe, expect, it } from 'vitest'
import { MAX_PTY_INACTIVE_CLEANUP_IDS, normalizePtyInactiveCleanupIds } from './pty-inactive-cleanup'

describe('normalizePtyInactiveCleanupIds', () => {
  it('keeps unique non-empty ids in request order', () => {
    expect(normalizePtyInactiveCleanupIds(['pty-a', '', 'pty-a', 7, 'pty-b'])).toEqual([
      'pty-a',
      'pty-b'
    ])
  })

  it('rejects non-arrays and caps the batch', () => {
    expect(normalizePtyInactiveCleanupIds(null)).toEqual([])
    expect(
      normalizePtyInactiveCleanupIds(
        Array.from({ length: MAX_PTY_INACTIVE_CLEANUP_IDS + 5 }, (_, index) => `pty-${index}`)
      )
    ).toHaveLength(MAX_PTY_INACTIVE_CLEANUP_IDS)
  })
})
```

- [ ] **Step 2: Run normalization tests and verify RED**

Run: `pnpm exec vitest run --config config/vitest.config.ts src/shared/pty-inactive-cleanup.test.ts`

Expected: FAIL because `src/shared/pty-inactive-cleanup.ts` does not exist.

- [ ] **Step 3: Implement shared wire types and normalization**

```ts
export const MAX_PTY_INACTIVE_CLEANUP_IDS = 500

export type PtyCleanupSafety = 'inactive' | 'active' | 'unknown' | 'gone'
export type PtyCleanupInspection = { id: string; safety: PtyCleanupSafety }
export type PtyInactiveCleanupOutcome =
  | 'killed'
  | 'protected-active'
  | 'protected-unknown'
  | 'gone'
  | 'failed'
export type PtyInactiveCleanupResult = { id: string; outcome: PtyInactiveCleanupOutcome }

export function normalizePtyInactiveCleanupIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0 || seen.has(candidate)) continue
    seen.add(candidate)
    ids.push(candidate)
    if (ids.length === MAX_PTY_INACTIVE_CLEANUP_IDS) break
  }
  return ids
}
```

- [ ] **Step 4: Run normalization tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write classifier tests**

Create table-driven tests that construct provider doubles and assert:

```ts
function makeProvider(args: {
  foreground: string | null
  children: boolean
  listedIds: string[]
}): PtyInactiveCleanupProvider {
  return {
    listProcesses: vi.fn(async () =>
      args.listedIds.map((id) => ({ id, cwd: '/tmp', title: id }))
    ),
    hasChildProcesses: vi.fn(async () => args.children),
    confirmForegroundProcess: vi.fn(async () => args.foreground)
  }
}

it.each([
  ['zsh', false, 'inactive'],
  ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', false, 'inactive'],
  ['codex', false, 'active'],
  ['bash', true, 'active']
] as const)('classifies %s with children=%s as %s', async (foreground, children, safety) => {
  const provider = makeProvider({ foreground, children, listedIds: ['pty-1'] })
  await expect(
    inspectPtyInactiveCleanupTargets([{ id: 'pty-1', provider }])
  ).resolves.toEqual([{ id: 'pty-1', safety }])
})

it('protects null foreground, missing provider, and rejected inspection as unknown', async () => {
  const nullForeground = makeProvider({ foreground: null, children: false, listedIds: ['a'] })
  const rejected = makeProvider({ foreground: 'zsh', children: false, listedIds: ['b'] })
  rejected.hasChildProcesses = vi.fn().mockRejectedValue(new Error('offline'))
  await expect(
    inspectPtyInactiveCleanupTargets([
      { id: 'a', provider: nullForeground },
      { id: 'b', provider: rejected },
      { id: 'c', provider: null }
    ])
  ).resolves.toEqual([
    { id: 'a', safety: 'unknown' },
    { id: 'b', safety: 'unknown' },
    { id: 'c', safety: 'unknown' }
  ])
})

it('lists once per provider and marks absent ids gone', async () => {
  const provider = makeProvider({ foreground: 'zsh', children: false, listedIds: ['a'] })
  await expect(
    inspectPtyInactiveCleanupTargets([
      { id: 'a', provider },
      { id: 'gone', provider }
    ])
  ).resolves.toEqual([
    { id: 'a', safety: 'inactive' },
    { id: 'gone', safety: 'gone' }
  ])
  expect(provider.listProcesses).toHaveBeenCalledOnce()
})
```

- [ ] **Step 6: Run classifier tests and verify RED**

Run: `pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/pty-inactive-cleanup.test.ts`

Expected: FAIL because the classifier does not exist.

- [ ] **Step 7: Implement provider-grouped classification**

Implement `inspectPtyInactiveCleanupTargets` with one `listProcesses()` call per provider object. A candidate is inactive only when child and fresh foreground calls both fulfill, children are false, foreground is non-null, and `isShellProcess(foreground)` is true. A positive child or non-shell foreground is active. Every other result is unknown; inventory absence is gone.

```ts
export type PtyInactiveCleanupProvider = Pick<
  IPtyProvider,
  'listProcesses' | 'hasChildProcesses' | 'confirmForegroundProcess'
>
export type PtyInactiveCleanupTarget = {
  id: string
  provider: PtyInactiveCleanupProvider | null
}

export async function inspectPtyInactiveCleanupTargets(
  targets: readonly PtyInactiveCleanupTarget[]
): Promise<PtyCleanupInspection[]> {
  const results = new Map(targets.map(({ id }) => [id, 'unknown' as PtyCleanupSafety]))
  const grouped = new Map<PtyInactiveCleanupProvider, string[]>()
  for (const { id, provider } of targets) {
    if (!provider) continue
    grouped.set(provider, [...(grouped.get(provider) ?? []), id])
  }
  await Promise.all(
    [...grouped].map(async ([provider, ids]) => {
      let listed: Set<string>
      try {
        listed = new Set((await provider.listProcesses()).map(({ id }) => id))
      } catch {
        return
      }
      await Promise.all(
        ids.map(async (id) => {
          if (!listed.has(id)) {
            results.set(id, 'gone')
            return
          }
          const [children, foreground] = await Promise.allSettled([
            provider.hasChildProcesses(id),
            provider.confirmForegroundProcess?.(id) ?? Promise.resolve(null)
          ])
          if (children.status === 'fulfilled' && children.value === true) {
            results.set(id, 'active')
          } else if (
            foreground.status === 'fulfilled' &&
            foreground.value !== null &&
            !isShellProcess(foreground.value)
          ) {
            results.set(id, 'active')
          } else if (
            children.status === 'fulfilled' &&
            children.value === false &&
            foreground.status === 'fulfilled' &&
            foreground.value !== null &&
            isShellProcess(foreground.value)
          ) {
            results.set(id, 'inactive')
          }
        })
      )
    })
  )
  return targets.map(({ id }) => ({ id, safety: results.get(id) ?? 'unknown' }))
}
```

- [ ] **Step 8: Run Task 1 suites and commit**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/pty-inactive-cleanup.test.ts \
  src/main/ipc/pty-inactive-cleanup.test.ts
git add src/shared/pty-inactive-cleanup.ts src/shared/pty-inactive-cleanup.test.ts \
  src/main/ipc/pty-inactive-cleanup.ts src/main/ipc/pty-inactive-cleanup.test.ts
git commit -m "fix(pty): classify inactive cleanup candidates safely"
```

Expected: all focused tests PASS; commit contains only Task 1 files.

---

### Task 2: Guarded main IPC and typed preload bridge

**Files:**
- Modify: `src/main/ipc/pty.ts`
- Modify: `src/main/ipc/pty.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/api-types.ts`

**Interfaces:**
- Consumes: Task 1 wire types, ID normalization, and classifier.
- Produces: `window.api.pty.inspectInactiveCleanup(ids)` and `window.api.pty.killInactiveSessions(ids)`.
- Preserves: existing `window.api.pty.kill(id, opts)` force semantics.

- [ ] **Step 1: Write IPC regression tests**

Add tests under `registerPtyHandlers` using the existing `handlers` map and provider doubles:

```ts
function makeCleanupProvider(args: {
  ids: string[]
  shutdown: ReturnType<typeof vi.fn>
  hasChildProcesses: (id: string) => Promise<boolean>
  confirmForegroundProcess: (id: string) => Promise<string | null>
}): never {
  return {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: args.shutdown,
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(args.hasChildProcesses),
    getForegroundProcess: vi.fn(),
    confirmForegroundProcess: vi.fn(args.confirmForegroundProcess),
    serialize: vi.fn(),
    revive: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () =>
      args.ids.map((id) => ({ id, cwd: '/tmp', title: id }))
    ),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn()
  } as never
}

it('guarded cleanup protects an active process and kills a confirmed idle shell', async () => {
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const foreground = vi.fn(async (id: string) => (id === 'idle' ? 'zsh' : 'claude'))
  setLocalPtyProvider(makeCleanupProvider({
    ids: ['idle', 'agent'],
    shutdown,
    hasChildProcesses: async (id) => id === 'agent',
    confirmForegroundProcess: foreground
  }))
  registerPtyHandlers(mainWindow as never)

  await expect(
    handlers.get('pty:inspectInactiveCleanup')!(null, { ids: ['idle', 'agent'] })
  ).resolves.toEqual([
    { id: 'idle', safety: 'inactive' },
    { id: 'agent', safety: 'active' }
  ])

  await expect(
    handlers.get('pty:killInactiveSessions')!(null, { ids: ['idle', 'agent'] })
  ).resolves.toEqual([
    { id: 'idle', outcome: 'killed' },
    { id: 'agent', outcome: 'protected-active' }
  ])
  expect(shutdown).toHaveBeenCalledOnce()
  expect(shutdown).toHaveBeenCalledWith('idle', { immediate: true, keepHistory: false })
})
```

Also assert disconnected SSH maps to `protected-unknown`, an ID gone between review and kill maps to `gone`, shutdown rejection maps to `failed` without stopping siblings, duplicate/invalid IDs are normalized, and handler disposal removes both new channels.

- [ ] **Step 2: Run IPC test and verify RED**

Run: `pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/pty.test.ts --testNamePattern "inactive cleanup"`

Expected: FAIL because the handlers are absent.

- [ ] **Step 3: Register guarded handlers and reuse exact shutdown lifecycle**

Extract the existing `pty:kill` body into a local `shutdownPty({ id, keepHistory })` function inside `registerPtyHandlers`. Register normal force kill as a thin call to it. Add:

```ts
ipcMain.handle('pty:inspectInactiveCleanup', async (_event, args: { ids?: unknown }) => {
  const ids = normalizePtyInactiveCleanupIds(args?.ids)
  return inspectPtyInactiveCleanupTargets(ids.map((id) => ({
    id,
    provider: resolveCleanupProvider(id)
  })))
})

ipcMain.handle('pty:killInactiveSessions', async (_event, args: { ids?: unknown }) => {
  const ids = normalizePtyInactiveCleanupIds(args?.ids)
  const inspections = await inspectPtyInactiveCleanupTargets(ids.map((id) => ({
    id,
    provider: resolveCleanupProvider(id)
  })))
  return Promise.all(inspections.map(async ({ id, safety }) => {
    if (safety === 'active') return { id, outcome: 'protected-active' as const }
    if (safety === 'unknown') return { id, outcome: 'protected-unknown' as const }
    if (safety === 'gone') return { id, outcome: 'gone' as const }
    try {
      await shutdownPty({ id, keepHistory: false })
      return { id, outcome: 'killed' as const }
    } catch {
      return { id, outcome: 'failed' as const }
    }
  }))
})
```

`resolveCleanupProvider` must honor `ptyOwnership` and parsed app-scoped SSH IDs; missing SSH providers return `null` and never fall back local. Add both channels to handler disposal.

- [ ] **Step 4: Add typed preload methods**

Import Task 1 result types into preload and API declarations, then expose:

```ts
inspectInactiveCleanup: (ids: string[]): Promise<PtyCleanupInspection[]> =>
  ipcRenderer.invoke('pty:inspectInactiveCleanup', { ids }),
killInactiveSessions: (ids: string[]): Promise<PtyInactiveCleanupResult[]> =>
  ipcRenderer.invoke('pty:killInactiveSessions', { ids }),
```

- [ ] **Step 5: Run IPC tests, node/web typecheck, and commit**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/ipc/pty-inactive-cleanup.test.ts src/main/ipc/pty.test.ts
pnpm run typecheck:node
pnpm run typecheck:web
git add src/main/ipc/pty.ts src/main/ipc/pty.test.ts src/preload/index.ts src/preload/api-types.ts
git commit -m "fix(pty): guard inactive session cleanup at shutdown"
```

Expected: tests and both typechecks PASS; force-kill tests remain unchanged.

---

### Task 3: Renderer review and confirmation coordinator

**Files:**
- Create: `src/renderer/src/components/status-bar/resource-session-cleanup-review.ts`
- Create: `src/renderer/src/components/status-bar/resource-session-cleanup-review.test.ts`
- Create: `src/renderer/src/components/status-bar/use-resource-session-cleanup-review.ts`
- Create: `src/renderer/src/components/status-bar/use-resource-session-cleanup-review.test.tsx`

**Interfaces:**
- Produces: `ResourceSessionCleanupReviewState` discriminated union.
- Produces: `reviewResourceSessionCleanup(deps)` and `executeResourceSessionCleanup(review, deps)` pure async coordinators.
- Produces: `useResourceSessionCleanupReview({ onSessionsLoaded })` with `review()`, `confirm()`, `retry()`, and `close()`.

- [ ] **Step 1: Write coordinator tests**

Tests inject `listSessions`, `readBindings`, `inspectInactiveCleanup`, and `killInactiveSessions` dependencies. Cover:

```ts
function session(id: string): DaemonSession {
  return { id, cwd: '/tmp', title: id }
}

function bindingsWith(...boundIds: string[]): ResourceSessionBindingInputs {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: { tab: boundIds },
    terminalLayoutsByTabId: {},
    workspaceSessionReady: true
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function reviewWithInactive(id: string): ResourceSessionCleanupReview {
  return {
    reviewedIds: [id],
    inspections: [{ id, safety: 'inactive' }],
    inactiveIds: [id],
    activeCount: 0,
    unknownCount: 0,
    goneCount: 0
  }
}

it('reviews only ids still unbound after the fresh list resolves', async () => {
  const list = deferred<DaemonSession[]>()
  const readBindings = vi.fn(() => bindingsWith('became-bound'))
  const inspect = vi.fn().mockResolvedValue([{ id: 'still-unbound', safety: 'inactive' }])
  const reviewPromise = reviewResourceSessionCleanup({
    listSessions: () => list.promise,
    readBindings,
    inspectInactiveCleanup: inspect
  })
  list.resolve([session('became-bound'), session('still-unbound')])
  const review = await reviewPromise
  expect(inspect).toHaveBeenCalledWith(['still-unbound'])
  expect(review.inactiveIds).toEqual(['still-unbound'])
})

it('re-intersects reviewed ids before guarded cleanup and never chases new sessions', async () => {
  const kill = vi.fn().mockResolvedValue([{ id: 'reviewed', outcome: 'killed' }])
  await executeResourceSessionCleanup(reviewWithInactive('reviewed'), {
    listSessions: async () => [session('reviewed'), session('new-session')],
    readBindings: () => bindingsWith('new-session'),
    killInactiveSessions: kill
  })
  expect(kill).toHaveBeenCalledWith(['reviewed'])
})
```

Also cover hydration false, all protected, gone IDs, review failure, final protected/failed counts, and a reviewed candidate becoming bound before confirmation.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run: `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/status-bar/resource-session-cleanup-review.test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement pure coordinator**

Build unbound IDs with `buildResourceSessionBindingIndex(readBindings()).boundPtyIds`. Preserve reviewed ID order, derive inactive/protected/gone counts from main inspection, and summarize final `killed`, `protected`, `gone`, and `failed` outcomes. Throw a stable renderer-owned error when `workspaceSessionReady` is false or IPC rejects.

- [ ] **Step 4: Run coordinator tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write and implement hook lifecycle tests**

Use `renderHook` to prove review/running/completed/error transitions, retry, dismissal locking while running, and no post-unmount React callbacks. The hook must let the already-confirmed main IPC settle after unmount while guarding only React state updates with `useMountedRef`.

- [ ] **Step 6: Run renderer coordinator/hook suites and commit**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/status-bar/resource-session-cleanup-review.test.ts \
  src/renderer/src/components/status-bar/use-resource-session-cleanup-review.test.tsx
git add src/renderer/src/components/status-bar/resource-session-cleanup-review.ts \
  src/renderer/src/components/status-bar/resource-session-cleanup-review.test.ts \
  src/renderer/src/components/status-bar/use-resource-session-cleanup-review.ts \
  src/renderer/src/components/status-bar/use-resource-session-cleanup-review.test.tsx
git commit -m "fix(resource-manager): reconcile unbound session cleanup"
```

Expected: focused tests PASS.

---

### Task 4: Confirmation UI and honest Resource Manager wiring

**Files:**
- Create: `src/renderer/src/components/status-bar/ResourceSessionCleanupDialog.tsx`
- Create: `src/renderer/src/components/status-bar/ResourceSessionCleanupDialog.test.tsx`
- Modify: `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx`
- Modify: `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.rows.test.tsx`
- Modify: `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.session-polling.test.ts`

**Interfaces:**
- Consumes: Task 3 hook state/actions.
- Preserves: existing individual force-kill dialog and exact `pty.kill` behavior after confirmation.

- [ ] **Step 1: Write dialog tests**

Render the new dialog under happy-dom and assert:

- reviewing state shows **Checking current process activity…** with no enabled destructive action;
- ready state distinguishes inactive candidates from active/unknown protected counts;
- zero inactive candidates cannot submit;
- running state disables dismissal and shows the canonical loader;
- completed state reports killed/protected/gone/failed counts without process names or paths;
- error state keeps Retry visible and kill disabled.

Use the real component API rather than snapshot-only assertions:

```tsx
it('protects active and unknown sessions while offering only inactive cleanup', () => {
  render(
    <ResourceSessionCleanupDialog
      state={{
        phase: 'ready',
        review: {
          reviewedIds: ['idle', 'agent', 'unknown'],
          inspections: [
            { id: 'idle', safety: 'inactive' },
            { id: 'agent', safety: 'active' },
            { id: 'unknown', safety: 'unknown' }
          ],
          inactiveIds: ['idle'],
          activeCount: 1,
          unknownCount: 1,
          goneCount: 0
        }
      }}
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
  expect(screen.getByText('1 inactive terminal can be closed.')).toBeTruthy()
  expect(screen.getByText('2 active or unverified terminals will be protected.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Kill 1 inactive terminal' })).toBeEnabled()
})
```

- [ ] **Step 2: Run dialog tests and verify RED**

Run: `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/status-bar/ResourceSessionCleanupDialog.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement dialog with existing primitives**

Use `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `Button`, and `LoaderCircle`. Keep `max-w-md`, `text-sm` title, `text-xs` description, outline Cancel/Close, destructive confirmed cleanup, and dismissal prevention only while running.

- [ ] **Step 4: Wire Resource Manager and remove confirmation bypass**

In `ResourceUsageStatusSegment.tsx`:

- rename `orphanCount` to `unboundCount`;
- change the action copy to **Review N unbound terminal(s)**;
- call the review hook instead of directly mapping `window.api.pty.kill`;
- render `ResourceSessionCleanupDialog` as a sibling of `PopoverContent`;
- simplify `handleKillSession` to `setKillConfirm(session)` for both bound and unbound rows;
- keep `runKillConfirmed` as the sole normal `pty.kill` force path;
- update comments that currently claim unbound rows are reclaimable.

- [ ] **Step 5: Add integration regressions**

Update row/polling tests to assert individual unbound rows still expose the explicit action, Resource Manager source contains no confirmation-bypass branch or `Promise.allSettled(orphans.map(...pty.kill))`, and no new child/foreground inspection runs from the closed/open polling effect.

- [ ] **Step 6: Run UI and neighboring regressions, then commit**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/status-bar/ResourceSessionCleanupDialog.test.tsx \
  src/renderer/src/components/status-bar/ResourceUsageStatusSegment.rows.test.tsx \
  src/renderer/src/components/status-bar/ResourceUsageStatusSegment.session-polling.test.ts \
  src/renderer/src/components/status-bar/resource-session-bindings.test.ts \
  src/renderer/src/components/status-bar/resource-session-count-selector.test.ts \
  src/renderer/src/components/status-bar/mergeSnapshotAndSessions.test.ts
git add src/renderer/src/components/status-bar/ResourceSessionCleanupDialog.tsx \
  src/renderer/src/components/status-bar/ResourceSessionCleanupDialog.test.tsx \
  src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx \
  src/renderer/src/components/status-bar/ResourceUsageStatusSegment.rows.test.tsx \
  src/renderer/src/components/status-bar/ResourceUsageStatusSegment.session-polling.test.ts
git commit -m "fix(resource-manager): review unbound terminals before cleanup"
```

Expected: focused UI and neighboring tests PASS.

---

### Task 5: Reliability gate, full verification, review, and PR

**Files:**
- Modify: `config/reliability-gates.jsonc`
- Keep: `docs/superpowers/specs/2026-07-13-resource-manager-unbound-session-safety-design.md`
- Keep: `docs/superpowers/plans/2026-07-13-resource-manager-unbound-session-safety.md`

**Interfaces:**
- Produces gate: `terminal-session.unbound-cleanup-safety`.

- [ ] **Step 1: Add an experimental partial reliability gate**

Register the invariant **renderer absence alone never authorizes PTY shutdown; guarded cleanup kills only freshly confirmed inactive shells**. List the Task 1–4 focused commands and assertion references. Cover deterministic local/daemon/SSH provider contracts; record live SSH, WSL, Linux, and Windows evidence as gaps rather than claims. Set `updatedAt` to `2026-07-13`.

- [ ] **Step 2: Run focused red/green regression command**

Run all Task 1–4 focused suites in one fresh Vitest invocation. Expected: PASS with zero failed tests.

- [ ] **Step 3: Run static and build gates**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run build:desktop
git diff --check origin/main...HEAD
```

Expected: all commands exit 0. Classify any unrelated baseline/environment failure with exact output before proceeding.

- [ ] **Step 4: Perform disposable packaged smoke**

Use only disposable terminals: one idle shell, one child process/non-shell command, and one unknown/disconnected provider fixture where available. Verify review counts, confirm only inactive cleanup, active process survival/input, dialog result copy, and no Orca main/renderer restart. Do not use existing user Agent sessions as targets.

- [ ] **Step 5: Review actual diff against the spec**

Read `git diff origin/main...HEAD`, verify every success criterion, inspect max-lines impact, confirm no new background provider polling, and confirm all new IPC routes preserve SSH ownership. Fix every confirmed Critical/Important finding and re-run affected checks.

- [ ] **Step 6: Commit gate/evidence, push, create PR, and wait for CI**

```bash
git add config/reliability-gates.jsonc
git add -f docs/superpowers/plans/2026-07-13-resource-manager-unbound-session-safety.md
git commit -m "test(resource-manager): gate unbound cleanup safety"
git push -u origin fix/resource-manager-orphan-safety
gh pr create --repo stablyai/orca --base main --head fix/resource-manager-orphan-safety \
  --title "fix(resource-manager): protect live unbound sessions from cleanup" \
  --body "Fixes #8459. Related to #8457. Replaces renderer-only orphan inference with explicit unbound-session review, provider-owned fail-closed process classification, and a guarded cleanup IPC that revalidates immediately before shutdown. Active and unverified sessions are protected. Includes deterministic local/daemon/SSH provider-contract coverage and records live cross-platform gaps. The separate serve/GUI lifecycle repair remains tracked by #8457."
```

The PR body must link #8459 and #8457, include the observed 28-kill incident without private paths, list red/green evidence and exact local commands, explain provider gaps, and state that #8457 lifecycle repair remains the next PR. Poll required checks until all complete; fix branch-caused failures and do not declare completion while CI is pending or red.
