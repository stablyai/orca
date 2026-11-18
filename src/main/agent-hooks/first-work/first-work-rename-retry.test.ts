import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/worktree/id'

const {
  gitExecFileAsyncMock,
  generateBranchNameMock,
  resolveParamsMock,
  resolveGenerationTargetMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  generateBranchNameMock: vi.fn(),
  resolveParamsMock: vi.fn(),
  resolveGenerationTargetMock: vi.fn()
}))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../../git/repositories/git-username', () => ({
  resolveLocalGitUsername: async () => null
}))
vi.mock('../../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: generateBranchNameMock,
  resolveCommitMessageSettings: resolveParamsMock
}))
vi.mock('./first-work-generation-target', () => ({
  resolveGenerationTarget: resolveGenerationTargetMock
}))
vi.mock('../../ipc/worktree-branch-name', () => ({
  computeBranchName: (leaf: string) => leaf,
  getConfiguredBranchPrefix: () => null
}))

import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './first-work-branch-rename'
import {
  FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS,
  retryFirstWorkRename,
  type FirstWorkRetryDeps
} from './first-work-rename-retry'
import { resetNativeFirstMessageReads } from './first-work-native-first-message'
import type { JournalFirstSubmittedPrompt } from '../../native-chat/agent-session-journal/journal-domain-first-submitted-prompt'
import {
  WORKTREE_ID,
  gitResponder,
  makeBranchRenameDeps,
  workingEvent
} from './testing/first-work-branch-rename-test-harness'

type Reads = FirstWorkRetryDeps['nativeReads']

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const noNativeChat: Reads = () => ({
  listSessionIds: async () => [],
  readFirst: async () => ({ kind: 'none' })
})

function changesGit(stat: string) {
  return async (args: string[]) => {
    if (args[0] === 'rev-parse') {
      return { stdout: 'base-sha\n' }
    }
    if (args[0] === 'merge-base') {
      return { stdout: 'merge-sha\n' }
    }
    return { stdout: args[0] === 'diff' && !args.includes('--cached') ? stat : '' }
  }
}

function makeRetryDeps(overrides: Partial<FirstWorkRetryDeps> = {}) {
  const base = makeBranchRenameDeps(vi.fn)
  const deps: FirstWorkRetryDeps = {
    ...base.deps,
    getWorkspaceCreatedAt: () => 100,
    getBaseRef: () => 'origin/main',
    nativeReads: noNativeChat,
    runGit: changesGit(''),
    ...overrides
  }
  return { ...base, deps }
}

beforeEach(() => {
  resetFirstWorkBranchRenameState()
  resetNativeFirstMessageReads()
  generateBranchNameMock.mockReset()
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(
    gitResponder({ currentBranch: 'Nautilus-8', hasUpstream: false })
  )
  resolveParamsMock.mockReturnValue({ ok: true, params: { agentId: 'claude' } })
  resolveGenerationTargetMock.mockReset()
  resolveGenerationTargetMock.mockResolvedValue({ kind: 'local' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('retryFirstWorkRename', () => {
  it('names the branch from the earliest qualifying native-chat message', async () => {
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-login' })
    const { deps } = makeRetryDeps({
      nativeReads: () => ({
        listSessionIds: async () => ['later', 'earlier'],
        readFirst: async (sessionId) =>
          sessionId === 'earlier'
            ? { kind: 'found', prompt: 'Fix the login form', submittedAt: 110, sequence: 9 }
            : { kind: 'found', prompt: 'Polish the README', submittedAt: 120, sequence: 1 }
      })
    })
    const result = await retryFirstWorkRename(WORKTREE_ID, deps)
    expect(result.outcome).toEqual({ kind: 'renamed' })
    expect(generateBranchNameMock.mock.calls[0][0].firstPrompt).toBe('Fix the login form')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'Nautilus-8', 'fix-login'],
      expect.anything()
    )
  })

  it('names from the changes, not deferring, when the native scan hits its bound', async () => {
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'login-form' })
    const { deps } = makeRetryDeps({
      runGit: changesGit(' src/login.tsx | 4 ++--\n'),
      nativeReads: () => ({
        listSessionIds: async () => ['long-chat'],
        // 513 unmatched submissions precede the first real message.
        readFirst: async () => ({ kind: 'incomplete' })
      })
    })
    await expect(retryFirstWorkRename(WORKTREE_ID, deps)).resolves.toMatchObject({
      outcome: { kind: 'renamed' }
    })
    expect(generateBranchNameMock.mock.calls[0][0]).toMatchObject({ fromChanges: true })
  })

  it('falls back to the branch changes and reports nothing-yet without generating', async () => {
    const { deps } = makeRetryDeps()
    const result = await retryFirstWorkRename(WORKTREE_ID, deps)
    expect(result.outcome).toEqual({ kind: 'nothing-yet' })
    expect(generateBranchNameMock).not.toHaveBeenCalled()

    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'login-form' })
    const withChanges = makeRetryDeps({ runGit: changesGit(' src/login.tsx | 4 ++--\n') })
    await expect(retryFirstWorkRename(WORKTREE_ID, withChanges.deps)).resolves.toMatchObject({
      outcome: { kind: 'renamed' }
    })
    expect(generateBranchNameMock.mock.calls[0][0]).toMatchObject({ fromChanges: true })
  })

  it('joins an automatic attempt for the same workspace instead of generating twice', async () => {
    const generation = deferred<{ success: true; slug: string }>()
    generateBranchNameMock.mockReturnValue(generation.promise)
    const { deps } = makeRetryDeps()
    const automatic = maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    await vi.waitFor(() => expect(generateBranchNameMock).toHaveBeenCalledTimes(1))
    const manual = retryFirstWorkRename(WORKTREE_ID, deps)
    generation.resolve({ success: true, slug: 'fix-auth' })
    await automatic
    await expect(manual).resolves.toMatchObject({ outcome: { kind: 'renamed' } })
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
  })

  it('defers after the lookup deadline and never generates from a late read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sessions = deferred<string[]>()
    const listSessionIds = vi.fn(() => sessions.promise)
    const { deps } = makeRetryDeps({
      nativeReads: () => ({
        listSessionIds,
        readFirst: async () => ({
          kind: 'found',
          prompt: 'Late message',
          submittedAt: 200,
          sequence: 1
        })
      })
    })
    const first = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.advanceTimersByTimeAsync(FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS)
    await expect(first).resolves.toMatchObject({
      outcome: { kind: 'deferred', reason: 'history-unreadable' }
    })
    // A second click while the read drains joins it rather than reading again.
    const second = retryFirstWorkRename(WORKTREE_ID, deps)
    expect(listSessionIds).toHaveBeenCalledTimes(1)
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'late-message' })
    sessions.resolve(['chat'])
    await expect(second).resolves.toMatchObject({ outcome: { kind: 'renamed' } })
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
  })

  it('submits no further native reads once an expired attempt has no live joiner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const firstRead = deferred<JournalFirstSubmittedPrompt>()
    const readFirst = vi.fn((sessionId: string) =>
      sessionId === 'chat-1' ? firstRead.promise : Promise.resolve({ kind: 'none' as const })
    )
    const { deps } = makeRetryDeps({
      nativeReads: () => ({ listSessionIds: async () => ['chat-1', 'chat-2'], readFirst })
    })
    const expired = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.advanceTimersByTimeAsync(FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS)
    await expect(expired).resolves.toMatchObject({ outcome: { kind: 'deferred' } })
    firstRead.resolve({ kind: 'none' })
    await vi.advanceTimersByTimeAsync(0)
    expect(readFirst.mock.calls.map(([id]) => id)).toEqual(['chat-1'])
  })

  it('keeps reading for a live joiner after the original attempt expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const firstRead = deferred<JournalFirstSubmittedPrompt>()
    const readFirst = vi.fn((sessionId: string): Promise<JournalFirstSubmittedPrompt> =>
      sessionId === 'chat-1'
        ? firstRead.promise
        : Promise.resolve({ kind: 'found', prompt: 'Add audit log', submittedAt: 300, sequence: 1 })
    )
    const { deps } = makeRetryDeps({
      nativeReads: () => ({ listSessionIds: async () => ['chat-1', 'chat-2'], readFirst })
    })
    const expired = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.advanceTimersByTimeAsync(FIRST_WORK_RETRY_LOOKUP_DEADLINE_MS)
    await expired
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'add-audit-log' })
    const paramsBefore = resolveParamsMock.mock.calls.length
    const joiner = retryFirstWorkRename(WORKTREE_ID, deps)
    // The lookup (and its join) starts in the same turn as the second params resolution.
    await vi.waitFor(() => expect(resolveParamsMock).toHaveBeenCalledTimes(paramsBefore + 1))
    firstRead.resolve({ kind: 'none' })
    await expect(joiner).resolves.toMatchObject({ outcome: { kind: 'renamed' } })
    expect(readFirst.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-2'])
  })

  it('launches no generation for a workspace replaced while the target was prepared', async () => {
    const target = deferred<{ kind: 'local' }>()
    resolveGenerationTargetMock.mockReturnValueOnce(target.promise)
    let incarnation = 'A'
    const { deps } = makeRetryDeps({
      runGit: changesGit(' a.ts | 1 +\n'),
      readIncarnation: () => incarnation
    })
    const result = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.waitFor(() => expect(resolveGenerationTargetMock).toHaveBeenCalled())
    incarnation = 'B'
    target.resolve({ kind: 'local' })
    await expect(result).resolves.toMatchObject({
      outcome: { kind: 'ineligible', reason: 'unavailable' }
    })
    expect(generateBranchNameMock).not.toHaveBeenCalled()
  })

  it('refuses the rename at child admission when a guard flips after the final recheck', async () => {
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-auth' })
    const admission = deferred<void>()
    const spawned: string[][] = []
    const respond = gitResponder({ currentBranch: 'Nautilus-8', hasUpstream: false })
    gitExecFileAsyncMock.mockImplementation(
      async (args: string[], options?: { canStart?: () => boolean }) => {
        if (args[0] === 'branch' && args[1] === '-m') {
          // Mirrors the runner: canStart runs after admission, immediately before spawning.
          await admission.promise
          if (options?.canStart?.() === false) {
            throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
          }
          spawned.push(args)
        }
        return respond(args)
      }
    )
    const { deps } = makeRetryDeps({ runGit: changesGit(' a.ts | 1 +\n') })
    const result = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.waitFor(() =>
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        expect.arrayContaining(['branch', '-m']),
        expect.anything()
      )
    )
    deps.getSettings().autoRenameBranchFromWork = false
    admission.resolve()
    await expect(result).resolves.toMatchObject({
      outcome: { kind: 'ineligible', reason: 'setting-off' }
    })
    expect(spawned).toEqual([])
  })

  it('renames nothing when the branch stops being eligible during generation', async () => {
    const generation = deferred<{ success: true; slug: string }>()
    generateBranchNameMock.mockReturnValue(generation.promise)
    let eligible = true
    const { deps } = makeRetryDeps({
      runGit: changesGit(' a.ts | 1 +\n'),
      canRenameOrcaCreatedBranch: () => eligible
    })
    const result = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.waitFor(() => expect(generateBranchNameMock).toHaveBeenCalled())
    eligible = false
    generation.resolve({ success: true, slug: 'fix-auth' })
    await expect(result).resolves.toMatchObject({
      outcome: { kind: 'ineligible', reason: 'name-chosen' }
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['branch', '-m']),
      expect.anything()
    )
  })

  it.each([
    ['setting turned off', 'setting-off'],
    ['branch ownership lost', 'name-chosen']
  ])('renames nothing when the %s during the final upstream probe', async (_label, reason) => {
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-auth' })
    let eligible = true
    const probe = deferred<void>()
    let probes = 0
    const respond = gitResponder({ currentBranch: 'Nautilus-8', hasUpstream: false })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      // The second upstream probe is the one inside the final recheck.
      if (args.some((arg) => arg.includes('@{u}')) && ++probes === 2) {
        await probe.promise
      }
      return respond(args)
    })
    const { deps } = makeRetryDeps({
      runGit: changesGit(' a.ts | 1 +\n'),
      canRenameOrcaCreatedBranch: () => eligible
    })
    const result = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.waitFor(() => expect(probes).toBe(2))
    if (reason === 'setting-off') {
      deps.getSettings().autoRenameBranchFromWork = false
    } else {
      eligible = false
    }
    probe.resolve()
    await expect(result).resolves.toMatchObject({ outcome: { kind: 'ineligible', reason } })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['branch', '-m']),
      expect.anything()
    )
  })

  it('drops a replaced workspace’s late failure instead of writing it to the new row', async () => {
    const generation = deferred<{ success: false; error: string }>()
    generateBranchNameMock.mockReturnValue(generation.promise)
    let incarnation = 'A'
    const { deps, setRenameError } = makeRetryDeps({
      runGit: changesGit(' a.ts | 1 +\n'),
      readIncarnation: () => incarnation
    })
    const result = retryFirstWorkRename(WORKTREE_ID, deps)
    await vi.waitFor(() => expect(generateBranchNameMock).toHaveBeenCalled())
    incarnation = 'B'
    generation.resolve({ success: false, error: 'usage limit' })
    await expect(result).resolves.toMatchObject({ outcome: { kind: 'ineligible' } })
    expect(setRenameError).not.toHaveBeenCalled()
  })
})
