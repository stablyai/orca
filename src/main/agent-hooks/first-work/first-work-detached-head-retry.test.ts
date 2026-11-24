import type * as GitCommandResolutionModule from '../../git/command-runner/host-routing/git-command-resolution'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BranchAutoRenameRetryResult } from '../../../shared/worktree/branch-auto-rename-attempt'
import { registerBranchAutoRenameRetryHandlers } from '../../ipc/worktrees/metadata/register-branch-auto-rename-retry-handlers'
import {
  armFirstWorkDetachedHeadCooldown,
  isFirstWorkDetachedHeadCoolingDown
} from './first-work-detached-head-cooldown'
import { isFirstWorkGenerationBackingOff } from './first-work-generation-backoff'
import { resetNativeFirstMessageReads } from './first-work-native-first-message'
import {
  isFirstWorkRenameSettled,
  resetFirstWorkBranchRenameState,
  startFirstWorkAttempt,
  type FirstWorkAttempt,
  type FirstWorkRenameVerdict
} from './first-work-rename-attempts'
import {
  FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS,
  type FirstWorkRetryDeps
} from './first-work-rename-retry'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from './first-work-structured-session-rename'
import {
  INCARNATION,
  WORKTREE_ID,
  createDeps,
  deferred,
  detachedReplier,
  drain,
  isSymbolicRef,
  onBranch,
  quietMiss,
  head,
  until,
  workingSummary,
  type GitChild,
  type GitReplier,
  type GitReply
} from './first-work-detached-head.test-fixture'

type GitCommandResolution = typeof GitCommandResolutionModule

type RetryHandler = (
  event: unknown,
  args: { worktreeId: string }
) => Promise<BranchAutoRenameRetryResult>

type HarnessState = {
  children: GitChild[]
  reply: GitReplier
  ipc: Map<string, RetryHandler>
  deps: FirstWorkRetryDeps | undefined
  generate: unknown[]
}

const h = vi.hoisted((): HarnessState => ({
  children: [],
  reply: () => ({ stdout: '' }),
  ipc: new Map(),
  deps: undefined,
  generate: []
}))

vi.mock('../../git/command-runner/process-capture/exec-file-capture', () => ({
  execFileCapture: async (
    binary: string,
    args: string[],
    options: { timeout?: number; onChildTerminated?: () => void }
  ) => {
    const { routeOf } = await import('./first-work-detached-head.test-fixture')
    const child = { route: routeOf(binary), args, timeout: options.timeout }
    h.children.push(child)
    const reply = await h.reply(child)
    // The runner waits for the first child's exit before a login-shell replay.
    options.onChildTerminated?.()
    if ('error' in reply) {
      throw reply.error
    }
    return { stdout: reply.stdout, stderr: '' }
  },
  execFileCaptureToTermination: () => Promise.reject(new Error('unused'))
}))
vi.mock('../../git/command-runner/host-routing/git-command-resolution', async (importOriginal) => {
  const actual = await importOriginal<GitCommandResolution>()
  const { routedCommand } = await import('./first-work-detached-head.test-fixture')
  return {
    ...actual,
    pendingWslDirectGitReadEnvironment: () => null,
    resolveGitCommand: (args: string[], options: { cwd: string }) =>
      routedCommand('native', args, options.cwd)
  }
})
vi.mock('../../git/worktrees/checkout/branch-rename', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeBranchUpstream: async () => ({ outcome: 'no-upstream' })
}))
vi.mock('../../text-generation/commit-message-text-generation', () => ({
  resolveCommitMessageSettings: () => ({ ok: true, params: { agentId: 'claude' } }),
  // Canceled: the attempt defers, so only the call itself is observed.
  generateBranchNameFromContext: async (context: unknown) => {
    h.generate.push(context)
    return { success: false, canceled: true, error: 'canceled' }
  }
}))
vi.mock('./first-work-generation-target', () => ({ resolveGenerationTarget: async () => ({}) }))
vi.mock('./first-work-rename-runtime', () => ({
  firstWorkRenameDeps: () => h.deps,
  firstWorkRetryDeps: () => h.deps
}))
vi.mock('../../ipc/ui', () => ({ sendToTrustedUIRenderer: () => {} }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: RetryHandler) => h.ipc.set(channel, handler)
  }
}))

const T0 = Date.UTC(2026, 0, 1)
const coolingAt = (at: number) => isFirstWorkDetachedHeadCoolingDown(WORKTREE_ID, INCARNATION, at)
const seedCooldown = () => armFirstWorkDetachedHeadCooldown(WORKTREE_ID, INCARNATION, Date.now())

function retryIpc(): Promise<BranchAutoRenameRetryResult> {
  const handler = h.ipc.get('worktrees:retryBranchAutoRename')!
  return handler({}, { worktreeId: WORKTREE_ID })
}

beforeAll(() => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rename deps factories are mocked, so the handlers never read the context
  registerBranchAutoRenameRetryHandlers({ store: {}, runtime: {} } as never)
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(T0)
  vi.stubEnv('ORCA_GIT_ADMISSION_DISABLED', '1')
  resetFirstWorkBranchRenameState()
  resetNativeFirstMessageReads()
  h.children = []
  h.generate = []
  h.reply = detachedReplier
  h.deps = createDeps()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('manual Retry clears the pause synchronously', () => {
  it('on join: the joined attempt cannot re-arm it', async () => {
    const held = deferred<GitReply>()
    h.reply = (child) => (isSymbolicRef(child) ? held.promise : head())
    // An automatic attempt held at its probe, with a pause seeded beside it.
    const turn = maybeAutoRenameWorkspaceOnFirstStructuredTurn(
      workingSummary(),
      { replay: false },
      createDeps()
    )
    await until(() => h.children.length === 1)
    seedCooldown()

    const joined = retryIpc()
    expect(coolingAt(Date.now())).toBe(false)

    held.resolve(quietMiss())
    await Promise.all([joined, turn])
    expect(h.children.map((child) => child.args[0])).toEqual(['symbolic-ref', 'rev-parse'])
    expect(coolingAt(Date.now())).toBe(false)
  })

  it('on start: the admitted attempt arms a fresh window when it confirms detached', async () => {
    seedCooldown()
    vi.setSystemTime(T0 + 10_000)

    const retried = retryIpc()
    expect(coolingAt(Date.now())).toBe(false)

    await retried
    expect(h.children).toHaveLength(2)
    expect(coolingAt(T0 + 39_999)).toBe(true)
    expect(coolingAt(T0 + 40_000)).toBe(false)
  })
})

describe('real Retry IPC lookup expiry (regression guard)', () => {
  it('the expired lookup returns history-unreadable and cannot generate, even after its read drains', async () => {
    const listed = deferred<{ sessionIds: string[]; hasUnreadable: boolean }>()
    let listCalls = 0
    h.reply = () => onBranch('Nautilus')
    h.deps = createDeps({
      getWorkspaceCreatedAt: () => 0,
      nativeReads: () => ({
        listSessions: () => {
          listCalls++
          return listed.promise
        },
        readFirst: async () => ({ kind: 'found', prompt: 'add login', submittedAt: 1, sequence: 1 })
      })
    })
    const first = retryIpc()
    await until(() => listCalls === 1)

    // Expiry, then a second click in the same turn, before the first attempt settles.
    vi.advanceTimersByTime(FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS)
    seedCooldown()
    const second = retryIpc()
    expect(coolingAt(Date.now())).toBe(false)

    expect((await first).outcome).toEqual({ kind: 'deferred', reason: 'history-unreadable' })
    expect(h.generate).toHaveLength(0)
    await until(() => h.children.length === 2)
    await drain()
    // The successor joined the still-draining physical read; releasing it serves only the successor.
    listed.resolve({ sessionIds: ['s1'], hasUnreadable: false })
    await second
    expect(listCalls).toBe(1)
    expect(h.generate).toEqual([{ firstPrompt: 'add login' }])
    expect(isFirstWorkRenameSettled(WORKTREE_ID, INCARNATION)).toBe(false)
    expect(isFirstWorkGenerationBackingOff(WORKTREE_ID, INCARNATION)).toBe(false)
    expect(coolingAt(Date.now())).toBe(false)
  })
})

// Controlled: the superseded attempt's verdict is injected, after a real lookup-expiry admission of the successor.
describe('controlled supersession: late verdicts', () => {
  const lateVerdicts: [string, FirstWorkRenameVerdict][] = [
    [
      'detached',
      { outcome: { kind: 'deferred', reason: 'interrupted' }, settles: false, detachedHead: true }
    ],
    ['definitive', { outcome: { kind: 'ineligible', reason: 'branch-renamed' }, settles: true }],
    ['generation failure', { outcome: { kind: 'failed' }, settles: false, generationFailed: true }]
  ]

  it.each(lateVerdicts)(
    'a late %s completion leaves a detached successor alone',
    async (_name, late) => {
      const superseded = startSupersededAttempt()
      await retryIpc()
      expect(coolingAt(T0 + 29_999)).toBe(true)

      vi.setSystemTime(T0 + 5_000)
      superseded.complete(late)
      await superseded.promise

      expect(isFirstWorkRenameSettled(WORKTREE_ID, INCARNATION)).toBe(false)
      expect(isFirstWorkGenerationBackingOff(WORKTREE_ID, INCARNATION)).toBe(false)
      expect(coolingAt(T0 + 29_999)).toBe(true)
      expect(coolingAt(T0 + 30_000)).toBe(false)
    }
  )

  it.each(lateVerdicts)(
    'a late %s completion leaves a settled successor alone',
    async (_name, late) => {
      h.reply = () => onBranch('feature/login')
      const superseded = startSupersededAttempt()
      await retryIpc()
      expect(isFirstWorkRenameSettled(WORKTREE_ID, INCARNATION)).toBe(true)

      superseded.complete(late)
      await superseded.promise

      expect(isFirstWorkRenameSettled(WORKTREE_ID, INCARNATION)).toBe(true)
      expect(isFirstWorkGenerationBackingOff(WORKTREE_ID, INCARNATION)).toBe(false)
      expect(coolingAt(Date.now())).toBe(false)
    }
  )
})

/** An attempt whose lookup expired, so Retry admits a successor; its verdict is supplied by the test. */
function startSupersededAttempt() {
  const verdict = deferred<FirstWorkRenameVerdict>()
  let attempt: FirstWorkAttempt | undefined
  const started = startFirstWorkAttempt(
    WORKTREE_ID,
    INCARNATION,
    (admitted) => {
      attempt = admitted
      return verdict.promise
    },
    createDeps()
  )
  attempt!.expireLookup()
  return { promise: started.promise, complete: verdict.resolve }
}
