import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence'
import {
  createFakeGitScript,
  fakeGit,
  gitCommands,
  isRemove,
  isSpareAdd,
  OID_A,
  OID_B,
  type FakeGitScript
} from './worktree-create-spare-test-harness'

const { gitExecFileAsyncMock, workspaceRoot } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  workspaceRoot: { value: '' }
}))
vi.mock('./git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('./ipc/worktree-logic', () => ({
  computeWorkspaceRootAsync: async () => workspaceRoot.value,
  getWorktreePathSettings: () => ({})
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({}),
  getWorktreeMirrorDistro: () => undefined
}))

import { clearGitCapabilityStateForTests } from './git/git-capability-state'
import { runLocalWorktreeCreate } from './git/worktree-create-git-executor'
import {
  _resetLocalWorktreeCreateActivityForTests,
  holdLocalWorktreeCreate
} from './git/local-worktree-create-activity'
import {
  _resetSparePoolForTests,
  abortSparesForQuit,
  findSpare,
  isSpareHookUnsupported,
  spareRepoKey
} from './worktree-create-preparation-pool'
import {
  _resetSpareRequestsForTests,
  _whenSpareRequestsSettledForTests,
  beginWorktreeCreateSpareRequest,
  requestWorktreeCreateSpare,
  SPARE_REQUEST_DEBOUNCE_MS,
  type SpareRequestTicket
} from './worktree-create-preparation'
import {
  _resetSpareGateForTests,
  recordPlainAddDuration,
  recordSpareBuildDuration,
  slowPlainAddThresholdMs,
  spareStartRefusal
} from './worktree-create-spare-gate'
import {
  scheduleSpareDiscard,
  _whenSpareDiscardsSettledForTests
} from './worktree-create-spare-discard'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request reads only getSettings, and both Store readers it calls are mocked above.
const store = { getSettings: () => ({}) } as unknown as Store
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local repo needs only id and path on this path; no connectionId, not a folder.
const repo = { id: 'repo', path: '/repo' } as unknown as Repo
const KEY = spareRepoKey('/repo')
let script: FakeGitScript

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  workspaceRoot.value = await realpath(await mkdtemp(join(tmpdir(), 'orca-spare-gate-')))
  script = createFakeGitScript()
  script.refs.set('refs/heads/other', OID_B)
  gitExecFileAsyncMock.mockImplementation(fakeGit(script))
  clearGitCapabilityStateForTests()
})

afterEach(async () => {
  vi.useRealTimers()
  _resetSpareRequestsForTests()
  _resetSparePoolForTests()
  _resetSpareGateForTests()
  _resetLocalWorktreeCreateActivityForTests()
  await rm(workspaceRoot.value, { recursive: true, force: true })
})

/** A composer pick: the ticket when it arrives, the request once its fetch settles. */
function pick(): SpareRequestTicket {
  const ticket = beginWorktreeCreateSpareRequest(store, repo)
  if (!ticket) {
    throw new Error('a local repo always gets a spare request ticket')
  }
  return ticket
}

async function request(base = 'origin/main'): Promise<void> {
  requestWorktreeCreateSpare(store, repo, base, pick())
  await vi.advanceTimersByTimeAsync(SPARE_REQUEST_DEBOUNCE_MS)
  await _whenSpareRequestsSettledForTests()
}

async function settle(): Promise<void> {
  await vi.waitFor(() => expect(findSpare(KEY)?.state ?? 'none').not.toBe('building'))
}

describe('rule 2: no spare while the machine is busy', () => {
  it('starts nothing while a local create is in flight', async () => {
    const release = holdLocalWorktreeCreate()
    await request()
    expect(script.calls).toHaveLength(0)
    release()
  })

  it('refuses for 3 minutes after a 16 s plain add when no spare was ever built', () => {
    recordPlainAddDuration(KEY, 16_000)
    vi.advanceTimersByTime(179_000)
    expect(spareStartRefusal()).toBe('slow_create_cooldown')
    vi.advanceTimersByTime(2_000)
    expect(spareStartRefusal()).toBeNull()

    recordPlainAddDuration(KEY, 14_000)
    expect(spareStartRefusal()).toBeNull()
  })

  it("sets the slow bar at twice the repo's fastest recent spare build", () => {
    recordSpareBuildDuration(KEY, 20_000)
    recordPlainAddDuration(KEY, 30_000)
    expect(spareStartRefusal()).toBeNull()

    recordPlainAddDuration(KEY, 41_000)
    expect(spareStartRefusal()).toBe('slow_create_cooldown')
  })

  it('ignores a spare build an outside load slowed', () => {
    for (const seconds of [3, 3, 3, 3, 60]) {
      recordSpareBuildDuration(KEY, seconds * 1_000)
    }
    expect(slowPlainAddThresholdMs(KEY)).toBe(15_000)
  })

  it('keeps a big repo with normal 20 s checkouts out of a permanent cooldown', () => {
    for (let build = 0; build < 3; build += 1) {
      recordSpareBuildDuration(KEY, 20_000)
    }
    recordPlainAddDuration(KEY, 20_000)
    vi.advanceTimersByTime(60_000)

    expect(spareStartRefusal()).toBeNull()
  })

  it('times the cooldown from the slow add, whatever a fast create does afterwards', () => {
    recordPlainAddDuration(KEY, 16_000)
    vi.advanceTimersByTime(100_000)
    recordPlainAddDuration(KEY, 2_000)
    vi.advanceTimersByTime(81_000)

    expect(spareStartRefusal()).toBeNull()
  })

  it('builds once for three requests inside the debounce, on the last base', async () => {
    requestWorktreeCreateSpare(store, repo, 'origin/main', pick())
    await vi.advanceTimersByTimeAsync(500)
    requestWorktreeCreateSpare(store, repo, 'origin/main', pick())
    await vi.advanceTimersByTimeAsync(500)
    await request('other')
    await settle()

    expect(gitCommands(script, isSpareAdd).map((call) => call.args.at(-1))).toEqual([OID_B])
  })

  it('keeps the spare when the gate refuses, and replaces it once per 30 s', async () => {
    await request()
    await settle()
    const release = holdLocalWorktreeCreate()
    await request('other')
    release()
    expect(findSpare(KEY)?.oid).toBe(OID_A)

    await request('other')
    await settle()
    expect(findSpare(KEY)?.oid).toBe(OID_B)
    await request()
    await settle()
    expect(findSpare(KEY)?.oid).toBe(OID_B)
    expect(gitCommands(script, isSpareAdd)).toHaveLength(2)
  })

  it('removes a spare only once local creates settle, at background priority', async () => {
    const release = holdLocalWorktreeCreate()
    scheduleSpareDiscard({
      id: '1-x',
      repoPath: '/repo',
      path: '/root/.orca-preparing/1-x',
      options: {}
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(gitCommands(script, isRemove)).toHaveLength(0)

    release()
    await _whenSpareDiscardsSettledForTests()
    expect(gitCommands(script, isRemove).map((call) => call.admissionTier)).toEqual(['background'])
  })
})

describe('what a spare must be able to honor', () => {
  it('builds no spare when Git lacks `hook run` and a post-checkout hook would run', async () => {
    script.hookRunSupported = false
    script.hookFile = process.execPath
    await request()
    await vi.waitFor(() => expect(isSpareHookUnsupported(KEY)).toBe(true))
    expect(gitCommands(script, isSpareAdd)).toHaveLength(0)

    script.hookFile = join(workspaceRoot.value, 'no-such-hook')
    clearGitCapabilityStateForTests()
    await request()
    await vi.waitFor(() => expect(findSpare(KEY)?.state).toBe('ready'))
    expect(findSpare(KEY)?.hookRun).toBe(false)
  })

  it('stops building and refuses new spares on quit', async () => {
    script.resetMode = 'hang'
    await request()
    await vi.waitFor(() => expect(script.resetSignals).toHaveLength(1))

    abortSparesForQuit()
    expect(script.resetSignals[0]?.aborted).toBe(true)
    expect(beginWorktreeCreateSpareRequest(store, repo)).toBeNull()
  })

  it('spawns no git for a request whose debounce fires after quit', async () => {
    requestWorktreeCreateSpare(store, repo, 'origin/main', pick())
    abortSparesForQuit()
    await vi.advanceTimersByTimeAsync(SPARE_REQUEST_DEBOUNCE_MS)
    await _whenSpareRequestsSettledForTests()

    expect(script.calls).toHaveLength(0)
  })
})

describe('which request a spare follows', () => {
  it('builds no spare for a request that a create started and finished inside', async () => {
    const ticket = pick()
    requestWorktreeCreateSpare(store, repo, 'origin/main', ticket)
    await runLocalWorktreeCreate(async () => {})
    await vi.advanceTimersByTimeAsync(SPARE_REQUEST_DEBOUNCE_MS)
    await _whenSpareRequestsSettledForTests()

    // A started spare is registered synchronously by the request that started it.
    expect(findSpare(KEY)).toBeUndefined()
  })

  it('follows the last pick even when an earlier pick’s fetch ends last', async () => {
    const slowPick = pick()
    const fastPick = pick()
    requestWorktreeCreateSpare(store, repo, 'other', fastPick)
    await vi.advanceTimersByTimeAsync(500)
    requestWorktreeCreateSpare(store, repo, 'origin/main', slowPick)
    await vi.advanceTimersByTimeAsync(SPARE_REQUEST_DEBOUNCE_MS)
    await _whenSpareRequestsSettledForTests()
    await settle()

    expect(gitCommands(script, isSpareAdd).map((call) => call.args.at(-1))).toEqual([OID_B])
  })

  it('says why a request built nothing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const release = holdLocalWorktreeCreate()
    await request()
    release()

    expect(info).toHaveBeenCalledWith(expect.stringContaining('create_in_flight'))
    info.mockRestore()
  })
})
