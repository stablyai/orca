import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/worktree/id'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { getDefaultSourceControlAiSettings } from '../../../shared/source-control/ai/settings/source-control-ai-settings'

const { gitExecFileAsyncMock, generateBranchNameMock, resolveGenerationTargetMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    generateBranchNameMock: vi.fn(),
    resolveGenerationTargetMock: vi.fn()
  })
)

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../../git/repositories/git-username', () => ({
  resolveLocalGitUsername: async () => null
}))
// Real settings resolution; only the agent launch is replaced.
vi.mock('../../text-generation/commit-message-text-generation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateBranchNameFromContext: generateBranchNameMock
}))
vi.mock('./first-work-generation-target', () => ({
  resolveGenerationTarget: resolveGenerationTargetMock
}))

import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './first-work-branch-rename'
import { retryFirstWorkRename, type FirstWorkRetryDeps } from './first-work-rename-retry'
import { installFirstWorkAttemptNotifier } from './first-work-rename-attempts'
import type { BranchAutoRenameAttemptEvent } from '../../../shared/worktree/branch-auto-rename-attempt'
import {
  FOLDER_WORKTREE_ID,
  WORKTREE_ID,
  gitResponder,
  makeBranchRenameDeps,
  workingEvent
} from './testing/first-work-branch-rename-test-harness'

function settingsWith(overrides: Partial<GlobalSettings>) {
  const { deps } = makeBranchRenameDeps(vi.fn)
  return { ...deps.getSettings(), ...overrides }
}

/** No agent chosen for the action, so the default launch agent is inherited; Claude stays enabled. */
function inheritedDefault(defaultTuiAgent: TuiAgent | 'blank') {
  return settingsWith({
    defaultTuiAgent,
    disabledTuiAgents: [],
    sourceControlAi: getDefaultSourceControlAiSettings()
  })
}

function setup(settings: ReturnType<typeof settingsWith>, worktreeId = WORKTREE_ID) {
  return makeBranchRenameDeps(vi.fn, {
    getSettings: () => settings,
    resolveWorktreeIdForTab: () => worktreeId,
    getFolderWorkspacePath: () => '/folder',
    isPendingFirstAgentMessageRename: () => true
  })
}

const launches = () =>
  resolveGenerationTargetMock.mock.calls.length + generateBranchNameMock.mock.calls.length

beforeEach(() => {
  resetFirstWorkBranchRenameState()
  generateBranchNameMock.mockReset()
  generateBranchNameMock.mockResolvedValue({ success: false, error: 'stop here' })
  resolveGenerationTargetMock.mockReset()
  resolveGenerationTargetMock.mockResolvedValue({ kind: 'local' })
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(
    gitResponder({ currentBranch: 'Nautilus-8', hasUpstream: false })
  )
})

describe('automatic naming with an inherited agent that cannot name', () => {
  it('keeps the branch name, launches nothing and leaves the badge alone', async () => {
    const finished = recordFinished()
    const { deps, setRenameError } = setup(inheritedDefault('gemini'))

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(launches()).toBe(0)
    expect(setRenameError).not.toHaveBeenCalled()
    // A failure dialog already following this attempt keeps its Try again.
    expect(finished).toMatchObject([{ outcome: { kind: 'failed' } }])
    // Settled: a later message does not try again.
    const gitCalls = gitExecFileAsyncMock.mock.calls.length
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock.mock.calls.length).toBe(gitCalls)
  })

  it('skips inherited Amp for branch names', async () => {
    const { deps, setRenameError } = setup(inheritedDefault('amp'))

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(launches()).toBe(0)
    expect(setRenameError).not.toHaveBeenCalled()
  })

  it('keeps a folder workspace title and launches nothing', async () => {
    const { deps, setRenameError, setDisplayName } = setup(
      inheritedDefault('gemini'),
      FOLDER_WORKTREE_ID
    )

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(launches()).toBe(0)
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setRenameError).not.toHaveBeenCalled()
  })

  it('still reports the reason when the user presses Try again on a folder workspace', async () => {
    const { deps, setRenameError } = retrySetup({}, FOLDER_WORKTREE_ID)

    const result = await retryFirstWorkRename(FOLDER_WORKTREE_ID, deps)

    expect(launches()).toBe(0)
    expect(result.outcome).toEqual({ kind: 'failed' })
    expect(setRenameError).toHaveBeenCalledWith(FOLDER_WORKTREE_ID, SETTINGS_HINT)
  })

  it('still launches Claude for a blank default launch agent', async () => {
    const { deps } = setup(inheritedDefault('blank'))

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(generateBranchNameMock.mock.calls[0]?.[1]).toMatchObject({ agentId: 'claude' })
  })

  it('still reports an explicitly chosen agent that cannot name branches', async () => {
    const sourceControlAi = getDefaultSourceControlAiSettings()
    sourceControlAi.actions = {
      ...sourceControlAi.actions,
      branchName: { commandInputTemplate: '{basePrompt}', agentId: 'amp' }
    }
    const { deps, setRenameError } = setup(settingsWith({ sourceControlAi }))

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(launches()).toBe(0)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, expect.stringContaining('Amp'))
  })

  it('still reports the reason when the user presses Try again', async () => {
    const { deps, setRenameError } = retrySetup()

    const result = await retryFirstWorkRename(WORKTREE_ID, deps)

    expect(launches()).toBe(0)
    expect(result.outcome).toEqual({ kind: 'failed' })
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, SETTINGS_HINT)
  })

  it('reports the reason when Try again joins a running automatic attempt', async () => {
    const releaseGit = holdGit()
    const finished = recordFinished()
    const { deps, setRenameError } = retrySetup()

    const automatic = maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    const clicked = retryFirstWorkRename(WORKTREE_ID, deps)
    releaseGit()
    await automatic
    const result = await clicked

    expect(launches()).toBe(0)
    expect(setRenameError.mock.calls).toEqual([[WORKTREE_ID, SETTINGS_HINT]])
    // The dialog may follow either the finished event or the reply; both must say failed.
    expect(result).toMatchObject({ attemptId: finished[0]?.attemptId, outcome: { kind: 'failed' } })
    expect(finished).toMatchObject([{ outcome: { kind: 'failed' } }])
  })

  it('does not blame settings when a joined attempt stops for another reason', async () => {
    const { deps, setRenameError } = retrySetup({ getRepo: () => undefined })

    const automatic = maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    const clicked = retryFirstWorkRename(WORKTREE_ID, deps)
    await automatic

    expect((await clicked).outcome).toEqual({ kind: 'ineligible', reason: 'unavailable' })
    expect(setRenameError).not.toHaveBeenCalled()
  })

  it('does not badge a workspace recreated while the joined attempt ran', async () => {
    const releaseGit = holdGit()
    let incarnation = 'first'
    const { deps, setRenameError } = retrySetup({ readIncarnation: () => incarnation })

    const automatic = maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    const clicked = retryFirstWorkRename(WORKTREE_ID, deps)
    incarnation = 'second'
    releaseGit()
    await automatic

    expect((await clicked).outcome).not.toEqual({ kind: 'failed' })
    expect(launches()).toBe(0)
    expect(setRenameError).not.toHaveBeenCalled()
  })
})

function recordFinished(): BranchAutoRenameAttemptEvent[] {
  const finished: BranchAutoRenameAttemptEvent[] = []
  installFirstWorkAttemptNotifier((event) => {
    if (event.phase === 'finished') {
      finished.push(event)
    }
  })
  return finished
}

/** Holds every git call until released, so a click can join the automatic attempt. */
function holdGit(): () => void {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const respond = gitResponder({ currentBranch: 'Nautilus-8', hasUpstream: false })
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    await held
    return respond(args)
  })
  return release
}

const SETTINGS_HINT = expect.stringContaining('Settings -> Git -> Source Control AI')

function retrySetup(overrides: Partial<FirstWorkRetryDeps> = {}, worktreeId = WORKTREE_ID) {
  const { deps: base, setRenameError } = setup(inheritedDefault('gemini'), worktreeId)
  const deps: FirstWorkRetryDeps = {
    ...base,
    ...overrides,
    getWorkspaceCreatedAt: () => 100,
    getBaseRef: () => 'origin/main',
    nativeReads: () => ({
      listSessions: async () => ({ sessionIds: [], hasUnreadable: false }),
      readFirst: async () => ({ kind: 'none' })
    }),
    runGit: async () => ({ stdout: '' })
  }
  return { deps, setRenameError }
}
