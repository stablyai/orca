import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeGitScript,
  fakeGit,
  gitCommands,
  isPlainAdd,
  isRemove,
  isSpareAdd,
  OID_A,
  OID_B,
  releaseResets,
  type FakeGitScript
} from './worktree-create-spare-test-harness'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))

import { addWorktree } from './git/worktree-add'
import { runLocalWorktreeCreate } from './git/worktree-create-git-executor'
import { isOwnedSpareId } from './git/worktree-create-spare-ids'
import { clearGitCapabilityStateForTests } from './git/git-capability-state'
import { _resetLocalWorktreeCreateActivityForTests } from './git/local-worktree-create-activity'
import {
  _resetSparePoolForTests,
  abortSparesForQuit,
  findSpare,
  hasSpareWork,
  spareRepoKey,
  startSpare
} from './worktree-create-preparation-pool'
import { _resetSpareGateForTests } from './worktree-create-spare-gate'
import { _whenSpareDiscardsSettledForTests } from './worktree-create-spare-discard'
import {
  _resetPendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval
} from './worktree-background-removal'

let root = ''
let script: FakeGitScript

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-spare-rules-')))
  script = createFakeGitScript()
  gitExecFileAsyncMock.mockImplementation(fakeGit(script))
  clearGitCapabilityStateForTests()
})

afterEach(async () => {
  releaseResets()
  _resetSparePoolForTests()
  _resetSpareGateForTests()
  _resetLocalWorktreeCreateActivityForTests()
  _resetPendingWorktreeRemovalsForTests()
  await rm(root, { recursive: true, force: true })
})

function spare(repoPath = '/repo', oid = OID_A, options: { wslDistro?: string } = {}): void {
  startSpare({ repoPath, workspaceRoot: root, oid, hookRun: true, options })
}

async function spareReady(repoPath = '/repo'): Promise<void> {
  await vi.waitFor(() => expect(findSpare(spareRepoKey(repoPath))?.state).toBe('ready'))
}

function create(repoPath = '/repo', branch = 'feature') {
  return runLocalWorktreeCreate(() =>
    addWorktree(repoPath, join(root, branch), branch, 'origin/main', false, false, {
      preparedCheckout: { workspaceRoot: root }
    })
  )
}

describe('rule 1: a create never waits on an unfinished spare', () => {
  it('runs a plain add while the spare reset never ends, even after its abort', async () => {
    script.resetMode = 'hang-ignoring-abort'
    spare()
    await vi.waitFor(() => expect(script.resetSignals).toHaveLength(1))

    const result = await create()

    expect(result.preparedCheckout).toEqual({ status: 'miss', reason: 'not_ready' })
    expect(gitCommands(script, isPlainAdd)).toHaveLength(1)
    expect(script.resetSignals[0]?.aborted).toBe(true)
  })

  it('discards a ready spare at another commit and runs a plain add', async () => {
    spare('/repo', OID_B)
    await spareReady()

    const result = await create()
    await _whenSpareDiscardsSettledForTests()

    expect(result.preparedCheckout).toEqual({ status: 'miss', reason: 'base_moved' })
    expect(gitCommands(script, isPlainAdd)).toHaveLength(1)
    expect(gitCommands(script, isRemove)).toHaveLength(1)
    expect(gitCommands(script, (args) => args[0] === 'reset')).toHaveLength(1)
  })

  it('never offers a spare whose reset exited after it was aborted', async () => {
    script.resetMode = 'resolve-on-abort'
    spare()
    await vi.waitFor(() => expect(script.resetSignals).toHaveLength(1))

    // Quit stops the build without marking it abandoned, so only the abort itself can refuse it.
    abortSparesForQuit()
    await _whenSpareDiscardsSettledForTests()
    await vi.waitFor(() => expect(gitCommands(script, isRemove)).toHaveLength(1))

    expect(findSpare(spareRepoKey('/repo'))).toBeUndefined()
  })

  it("stops another repo's unfinished spare when a create starts", async () => {
    script.resetMode = 'hang'
    spare('/repo-b')
    await vi.waitFor(() => expect(script.resetSignals).toHaveLength(1))

    await create('/repo-a')

    expect(script.resetSignals[0]?.aborted).toBe(true)
    expect(findSpare(spareRepoKey('/repo-b'))).toBeUndefined()
  })

  it("labels a create not_ready only when its own repo's spare was stopped", async () => {
    script.resetMode = 'hang'
    spare('/repo-b')
    await vi.waitFor(() => expect(script.resetSignals).toHaveLength(1))

    expect((await create('/repo-a')).preparedCheckout).toEqual({ status: 'miss', reason: 'none' })
    expect((await create('/repo-b')).preparedCheckout).toEqual({ status: 'miss', reason: 'none' })
  })

  it("leaves another repo's ready spare for its own create", async () => {
    spare('/repo-b')
    await spareReady('/repo-b')

    await create('/repo-a')
    const result = await create('/repo-b')

    expect(result.preparedCheckout).toEqual({ status: 'hit' })
    expect(gitCommands(script, isPlainAdd)).toHaveLength(1)
  })

  it('leaves a WSL spare to finish instead of killing it, then discards it', async () => {
    script.resetMode = 'hang-ignoring-abort'
    startSpare({
      repoPath: '/repo',
      workspaceRoot: root,
      oid: OID_A,
      hookRun: true,
      options: { wslDistro: 'Ubuntu' }
    })
    await vi.waitFor(() => expect(script.resetSignals).toHaveLength(1))

    await create('/repo-a')
    expect(script.resetSignals[0]?.aborted).toBe(false)
    expect(gitCommands(script, isRemove)).toHaveLength(0)

    releaseResets()
    await vi.waitFor(() => expect(gitCommands(script, isRemove)).toHaveLength(1))
    expect(findSpare(spareRepoKey('/repo', 'Ubuntu'))).toBeUndefined()
  })
})

describe('a spare that never got far', () => {
  it('starts no checkout for a WSL spare abandoned while it was still registering', async () => {
    let releaseAdd: () => void = () => {}
    script.spareAddGate = new Promise((resolve) => {
      releaseAdd = resolve
    })
    spare('/repo', OID_A, { wslDistro: 'Ubuntu' })
    await vi.waitFor(() => expect(gitCommands(script, isSpareAdd)).toHaveLength(1))

    await create('/repo-a')
    expect(hasSpareWork()).toBe(true)
    releaseAdd()

    await vi.waitFor(() => expect(gitCommands(script, isRemove)).toHaveLength(1))
    expect(script.resetSignals).toHaveLength(0)
    await vi.waitFor(() => expect(hasSpareWork()).toBe(false))
  })

  it('runs neither add nor lock for a WSL spare abandoned before it registered', async () => {
    spare('/repo', OID_A, { wslDistro: 'Ubuntu' })
    const id = findSpare(spareRepoKey('/repo', 'Ubuntu'))?.id ?? ''

    await create('/repo-a')

    await vi.waitFor(() => expect(isOwnedSpareId(id)).toBe(false))
    expect(gitCommands(script, isSpareAdd)).toHaveLength(0)
    expect(gitCommands(script, (args) => args[1] === 'lock')).toHaveLength(0)
    expect(script.resetSignals).toHaveLength(0)
  })

  it('removes nothing and releases the id when the spare never registered', async () => {
    spare()
    const id = findSpare(spareRepoKey('/repo'))?.id ?? ''
    abortSparesForQuit()

    await vi.waitFor(() => expect(isOwnedSpareId(id)).toBe(false))
    expect(gitCommands(script, isSpareAdd)).toHaveLength(0)
    expect(gitCommands(script, isRemove)).toHaveLength(0)
  })
})

describe('the create path around a ready spare', () => {
  it('hands a ready spare over with a plain create’s hook arguments and no checkout', async () => {
    spare()
    await spareReady()

    const result = await create()

    expect(result.preparedCheckout).toEqual({ status: 'hit' })
    expect(gitCommands(script, isPlainAdd)).toHaveLength(0)
    const hook = gitCommands(script, (args) => args.includes('post-checkout'))
    expect(hook.map((call) => call.args.slice(-3))).toEqual([['0'.repeat(40), OID_A, '1']])
  })

  it('puts the spare back and runs a plain add when the branch cannot be attached', async () => {
    script.failing.add('symbolic-ref')
    spare()
    await spareReady()
    script.failing.add('remove')

    const result = await create()

    expect(result.preparedCheckout).toEqual({ status: 'miss', reason: 'finalize_failed' })
    expect(gitCommands(script, (args) => args[0] === 'branch' && args[1] === '-D')).toHaveLength(1)
    expect(gitCommands(script, (args) => args[1] === 'move')).toHaveLength(2)
    expect(gitCommands(script, isPlainAdd)).toHaveLength(1)
  })

  it('succeeds when the unlock fails, and retries it once in the background', async () => {
    spare()
    await spareReady()
    script.failing.add('unlock')

    const result = await create()

    expect(result.preparedCheckout).toEqual({ status: 'hit' })
    await vi.waitFor(() =>
      expect(gitCommands(script, (args) => args[1] === 'unlock')).toHaveLength(2)
    )
  })

  it('refuses a create at a path still being deleted without touching the spare', async () => {
    spare()
    await spareReady()
    void startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: `repo::${join(root, 'feature')}`,
        repoId: 'repo',
        repoPath: '/repo',
        worktree: { path: join(root, 'feature'), branch: 'refs/heads/old', head: OID_A },
        deleteBranch: false,
        force: false
      },
      run: () => new Promise(() => {}),
      publish: () => {}
    })

    await expect(create()).rejects.toThrow('Cleanup is pending')
    expect(gitCommands(script, (args) => args[1] === 'move')).toHaveLength(0)
    expect(findSpare(spareRepoKey('/repo'))?.state).toBe('ready')
  })
})

describe('rule 3: a create never builds another spare', () => {
  it('builds nothing after either of two hits', async () => {
    spare()
    await spareReady()
    expect((await create('/repo', 'one')).preparedCheckout).toEqual({ status: 'hit' })
    spare()
    await spareReady()
    expect((await create('/repo', 'two')).preparedCheckout).toEqual({ status: 'hit' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(gitCommands(script, isSpareAdd)).toHaveLength(2)
    expect(findSpare(spareRepoKey('/repo'))).toBeUndefined()
  })

  it('keeps at most three spares on the machine, dropping the oldest', async () => {
    for (const repoPath of ['/repo-1', '/repo-2', '/repo-3', '/repo-4']) {
      spare(repoPath)
    }
    await spareReady('/repo-4')

    expect(findSpare(spareRepoKey('/repo-1'))).toBeUndefined()
    expect(findSpare(spareRepoKey('/repo-2'))?.state).toBe('ready')
  })

  it('keeps one spare per repo when a second base is requested', async () => {
    spare('/repo', OID_A)
    spare('/repo', OID_B)
    await spareReady()

    expect(findSpare(spareRepoKey('/repo'))?.oid).toBe(OID_B)
  })
})
