import type * as GitCommandResolutionModule from '../../git/command-runner/host-routing/git-command-resolution'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitCommandTimeoutError } from '../../../shared/git/commands/git-command-timeout'
import {
  armFirstWorkDetachedHeadCooldown,
  isFirstWorkDetachedHeadCoolingDown,
  FIRST_WORK_DETACHED_HEAD_COOLDOWN_LIMIT
} from './first-work-detached-head-cooldown'
import { resetFirstWorkBranchRenameState } from './first-work-rename-attempts'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from './first-work-structured-session-rename'
import { installFirstWorkRenameHookSubscription } from './first-work-rename-hook-subscription'
import {
  INCARNATION,
  WORKTREE_ID,
  createDeps,
  deferred,
  detachedReplier,
  drain,
  gitExit,
  head,
  isSymbolicRef,
  onBranch,
  quietMiss,
  until,
  workingSummary,
  type GitChild,
  type GitReplier,
  type GitReply,
  type GitRoute
} from './first-work-detached-head.test-fixture'

type GitCommandResolution = typeof GitCommandResolutionModule

type HarnessState = {
  firstRoute: GitRoute
  children: GitChild[]
  reply: GitReplier
  hookListener: ((event: unknown) => void) | undefined
}

const h = vi.hoisted((): HarnessState => ({
  firstRoute: 'native',
  children: [],
  reply: () => ({ stdout: '' }),
  hookListener: undefined
}))

// The child seam: every capture the real git runner starts, tagged with its route.
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
// Route selection only; replay, quiet-exit and WSL-failure classification stay real.
vi.mock('../../git/command-runner/host-routing/git-command-resolution', async (importOriginal) => {
  const actual = await importOriginal<GitCommandResolution>()
  const { routedCommand } = await import('./first-work-detached-head.test-fixture')
  return {
    ...actual,
    pendingWslDirectGitReadEnvironment: () => null,
    resolveGitCommand: (args: string[], options: { cwd: string }, forceLoginShell = false) =>
      routedCommand(forceLoginShell ? 'login' : h.firstRoute, args, options.cwd)
  }
})
vi.mock('../server/agent-hook-server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: (event: unknown) => void) => {
      h.hookListener = listener
      return () => {}
    }
  }
}))

const T0 = Date.UTC(2026, 0, 1)
const deps = createDeps()
let uninstallHook: () => void = () => {}

function structuredTurn(): Promise<void> {
  return maybeAutoRenameWorkspaceOnFirstStructuredTurn(workingSummary(), { replay: false }, deps)!
}

function hookTurn(): void {
  h.hookListener!({
    paneKey: '',
    tabId: undefined,
    worktreeId: WORKTREE_ID,
    payload: { state: 'working', prompt: 'fix the login bug' },
    isReplay: false
  })
}

const coolingAt = (at: number) => isFirstWorkDetachedHeadCoolingDown(WORKTREE_ID, INCARNATION, at)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(T0)
  vi.stubEnv('ORCA_GIT_ADMISSION_DISABLED', '1')
  resetFirstWorkBranchRenameState()
  h.firstRoute = 'native'
  h.children = []
  h.reply = detachedReplier
  uninstallHook = installFirstWorkRenameHookSubscription(deps)
})

afterEach(() => {
  uninstallHook()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// Routes are synthetic: route selection is stubbed, replay and quiet-exit handling are the real runner's.
describe('confirmed detached HEAD on the final routed result', () => {
  it('runs exactly the two proving commands', async () => {
    await structuredTurn()

    expect(h.children.map((child) => child.args)).toEqual([
      ['symbolic-ref', '--quiet', 'HEAD'],
      ['rev-parse', '--symbolic-full-name', 'HEAD']
    ])
  })

  const directThenLogin =
    (direct: GitReplier, login: GitReplier): GitReplier =>
    (child) =>
      child.route === 'direct' ? direct(child) : login(child)
  const fatal = () => gitExit(128, 'fatal: not a git repository')
  const rcNoise = () => gitExit(1, 'Welcome to Ubuntu\n')

  it.each<[string, GitRoute, GitReplier, GitRoute[]]>([
    ['native', 'native', detachedReplier, ['native', 'native']],
    [
      'direct WSL git (quiet exit 1 is not replayed)',
      'direct',
      detachedReplier,
      ['direct', 'direct']
    ],
    ['WSL shell selected first', 'login', detachedReplier, ['login', 'login']],
    [
      'direct exit 128 with a WSL shell replay',
      'direct',
      directThenLogin((child) => (isSymbolicRef(child) ? fatal() : head()), detachedReplier),
      ['direct', 'login', 'direct']
    ],
    [
      'both reads with a WSL shell replay',
      'direct',
      directThenLogin(fatal, detachedReplier),
      ['direct', 'login', 'direct', 'login']
    ],
    [
      'whitespace-only stderr, confirmed',
      'native',
      (child) => (isSymbolicRef(child) ? gitExit(1, ' \r\n') : head()),
      ['native', 'native']
    ]
  ])('%s arms 30 s from completion', async (_name, route, replier, routes) => {
    h.firstRoute = route
    h.reply = replier
    await structuredTurn()

    expect(h.children.map((child) => child.route)).toEqual(routes)
    expect(h.children.every((child) => child.timeout === 120_000)).toBe(true)
    expect(coolingAt(T0 + 29_999)).toBe(true)
    expect(coolingAt(T0 + 30_000)).toBe(false)
  })

  it.each<[string, GitRoute, GitReplier]>([
    // Diagnostic stderr is ambiguous even when the confirmation would print HEAD.
    ['WSL shell rc noise on stderr', 'login', (c) => (isSymbolicRef(c) ? rcNoise() : head())],
    [
      'WSL shell replay that prints noise',
      'direct',
      directThenLogin(fatal, (c) => (isSymbolicRef(c) ? rcNoise() : head()))
    ],
    [
      'whitespace-only stderr, confirm fails',
      'native',
      (c) => (isSymbolicRef(c) ? gitExit(1, '\n') : fatal())
    ],
    ['confirm exit 128', 'native', (child) => (isSymbolicRef(child) ? quietMiss() : fatal())],
    [
      'confirm names a branch',
      'native',
      (c) => (isSymbolicRef(c) ? quietMiss() : onBranch('main'))
    ],
    ['exit 128', 'native', fatal],
    ['timeout', 'native', () => ({ error: new GitCommandTimeoutError(120_000) })],
    ['killed', 'native', (c) => (isSymbolicRef(c) ? gitExit(1, '', { killed: true }) : head())],
    [
      'signal',
      'native',
      (c) => (isSymbolicRef(c) ? gitExit(1, '', { signal: 'SIGTERM' }) : head())
    ],
    [
      'WSL host failure',
      'native',
      (c) => (isSymbolicRef(c) ? gitExit(1, '', { wslHostFailure: true }) : head())
    ],
    ['tag symref', 'native', () => ({ stdout: 'refs/tags/v1\n' })]
  ])('%s stays retryable', async (_name, route, replier) => {
    h.firstRoute = route
    h.reply = replier
    await structuredTurn()
    const probes = h.children.length

    expect(coolingAt(T0)).toBe(false)
    await structuredTurn()
    expect(h.children.length).toBe(probes * 2)
  })
})

describe('both automatic sources', () => {
  it.each<[string, () => Promise<void>]>([
    ['structured session', structuredTurn],
    [
      'terminal hook',
      async () => {
        hookTurn()
        // The hook source is fire-and-forget.
        await drain()
      }
    ]
  ])('%s: 20 events in the window start one probe pair', async (_name, fire) => {
    for (let second = 0; second < 30; second += 1.5) {
      vi.setSystemTime(T0 + second * 1000)
      await fire()
    }
    expect(h.children.map((child) => child.args[0])).toEqual(['symbolic-ref', 'rev-parse'])

    vi.setSystemTime(T0 + 30_000)
    await fire()
    expect(h.children).toHaveLength(4)
  })

  it('measures the window from the confirming read, not admission', async () => {
    const held = deferred<GitReply>()
    h.reply = (child) =>
      isSymbolicRef(child) ? quietMiss() : h.children.length === 2 ? held.promise : head()
    const turn = structuredTurn()
    await until(() => h.children.length === 2)

    vi.setSystemTime(T0 + 25_000)
    held.resolve(head())
    await turn

    vi.setSystemTime(T0 + 54_999)
    await structuredTurn()
    expect(h.children).toHaveLength(2)
    vi.setSystemTime(T0 + 55_000)
    await structuredTurn()
    expect(h.children).toHaveLength(4)
  })
})

it('a detached verdict from a replaced incarnation writes no pause', async () => {
  let incarnation = INCARNATION
  const held = deferred<GitReply>()
  h.reply = (child) => (isSymbolicRef(child) ? quietMiss() : held.promise)
  const replacedDeps = createDeps({ readIncarnation: () => incarnation })
  const turn = maybeAutoRenameWorkspaceOnFirstStructuredTurn(
    workingSummary(),
    { replay: false },
    replacedDeps
  )!
  await until(() => h.children.length === 2)

  incarnation = 'incarnation-2'
  held.resolve(head())
  await turn

  // Read as the old incarnation so a wrongly written pause is seen, not cleaned up.
  expect(coolingAt(T0)).toBe(false)
})

it('keeps at most 512 pauses and drops another incarnation on read', () => {
  for (let i = 0; i <= FIRST_WORK_DETACHED_HEAD_COOLDOWN_LIMIT; i++) {
    armFirstWorkDetachedHeadCooldown(`w${i}`, INCARNATION, T0)
  }
  expect(isFirstWorkDetachedHeadCoolingDown('w0', INCARNATION, T0)).toBe(false)
  expect(isFirstWorkDetachedHeadCoolingDown('w1', INCARNATION, T0)).toBe(true)
  expect(isFirstWorkDetachedHeadCoolingDown('w2', 'recreated', T0)).toBe(false)
  expect(isFirstWorkDetachedHeadCoolingDown('w2', INCARNATION, T0)).toBe(false)
})
