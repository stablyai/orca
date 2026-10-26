import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from './first-work-structured-session-rename'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'

const {
  gitExecFileAsyncMock,
  resolveLocalGitUsernameMock,
  generateBranchNameMock,
  resolveTextGenerationParamsMock,
  prepareLocalEnvMock,
  computeBranchNameMock,
  getConfiguredBranchPrefixMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  resolveLocalGitUsernameMock: vi.fn(async () => 'you'),
  generateBranchNameMock: vi.fn(),
  resolveTextGenerationParamsMock: vi.fn(),
  prepareLocalEnvMock: vi.fn(async () => ({ ok: true as const })),
  computeBranchNameMock: vi.fn((leaf: string) => `you/${leaf}`),
  getConfiguredBranchPrefixMock: vi.fn((_settings: unknown, username: string | null) => username)
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: resolveLocalGitUsernameMock }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: generateBranchNameMock,
  resolveTextGenerationParams: resolveTextGenerationParamsMock
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: prepareLocalEnvMock
}))
vi.mock('../ipc/worktree-branch-name', () => ({
  computeBranchName: computeBranchNameMock,
  getConfiguredBranchPrefix: getConfiguredBranchPrefixMock
}))

import {
  FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT,
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState,
  type FirstWorkBranchRenameDeps
} from './first-work-branch-rename'
import {
  FOLDER_WORKTREE_ID,
  REPO_ID,
  WORKTREE_ID,
  gitResponder,
  makeBranchRenameDeps,
  noUpstreamError,
  workingEvent
} from './first-work-branch-rename-test-harness'
import { FIRST_WORK_GENERATION_RETRY_DELAYS_MS } from './first-work-generation-backoff'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const REMOTE_REPO_BASE: Repo = {
  id: REPO_ID,
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0
}

function makeDeps(overrides: Partial<FirstWorkBranchRenameDeps> = {}) {
  return makeBranchRenameDeps(vi.fn, overrides)
}

let clockMs = 0
function elapseGenerationBackoff(): void {
  clockMs += Math.max(...FIRST_WORK_GENERATION_RETRY_DELAYS_MS)
}

describe('maybeAutoRenameBranchOnFirstWork', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    resetFirstWorkBranchRenameState()
    vi.clearAllMocks()
    clockMs = 0
    vi.spyOn(Date, 'now').mockImplementation(() => clockMs)
    resolveLocalGitUsernameMock.mockResolvedValue('you')
    computeBranchNameMock.mockImplementation((leaf: string) => `you/${leaf}`)
    prepareLocalEnvMock.mockResolvedValue({ ok: true })
    resolveTextGenerationParamsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'claude', model: 'm' }
    })
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-auth' })
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: false })
    )
  })

  it.each([
    ['claude', WORKTREE_ID],
    ['codex', WORKTREE_ID],
    ['claude', FOLDER_WORKTREE_ID],
    ['codex', FOLDER_WORKTREE_ID]
  ] as const)(
    'renames %s workspace %s on live work without a subscriber, preserving replay, dedupe and retries',
    async (agent, workspaceId) => {
      const { deps, setDisplayName } = makeDeps({
        getFolderWorkspacePath: () => '/workspace/platform',
        isPendingFirstAgentMessageRename: () => true
      })
      const items: AgentJournalRenderItem[] = []
      // Advance journal sequence so projection caching cannot hide a rename event.
      let sequence = 0
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status feed uses these held rows and provenance reads; the item lookup is checked against the real journal contract.
      const journal = {
        snapshot: () => ({ items, submissions: [] }),
        context: { floor: () => null },
        item: ((itemId) =>
          items.find((item) => item.itemId === itemId) ??
          null) satisfies AgentSessionJournal['item'],
        stopMarks: { latest: () => null, revision: () => 0 },
        lastActivityAt: () => 1,
        cursor: () => ({ epoch: 1, sequence: (sequence += 1) }),
        itemFence: () => undefined,
        wroteBeforeOpen: () => false,
        runningTurn: () => null
      } as unknown as AgentSessionJournal
      const pending: Promise<void>[] = []
      const observe = vi.fn((summary, options) => {
        const work = maybeAutoRenameWorkspaceOnFirstStructuredTurn(summary, options, deps)
        if (work) {
          pending.push(work)
        }
      })
      const feed = new StructuredAgentSessionStatusFeed({
        logger: createStructuredAgentSessionLogger(),
        sessions: new Map([
          [
            'session',
            {
              journal,
              params: {
                location: {
                  executionHostId: 'local',
                  wslDistro: null,
                  workspaceId,
                  workspaceKind: 'git-worktree'
                },
                provider: agent
              }
            }
          ]
        ]),
        getRecord: () => null,
        now: () => 1,
        onStatusChanged: observe
      })
      const user = {
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Fix auth' }] }
      } as AgentJournalRenderItem
      const turn = {
        body: {
          kind: 'status',
          text: 'Working',
          turnLifecycle: { turnId: 'turn-1', state: 'running' }
        }
      } as AgentJournalRenderItem
      items.push(user, turn)
      feed.publish('session', journal, { replay: true })
      await Promise.all(pending)
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()

      items.pop()
      feed.publish('session', journal)
      items.push(turn)
      generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'temporary failure' })
      feed.publish('session', journal)
      await Promise.all(pending)
      expect(generateBranchNameMock).toHaveBeenCalledOnce()
      expect(setDisplayName).not.toHaveBeenCalled()
      const callsBeforeOutput = observe.mock.calls.length
      for (let index = 0; index < 100; index++) {
        feed.publish('session', journal)
      }
      expect(observe).toHaveBeenCalledTimes(callsBeforeOutput)

      elapseGenerationBackoff()
      items.pop()
      feed.publish('session', journal)
      items.push(turn)
      feed.publish('session', journal)
      await Promise.all(pending)
      expect(generateBranchNameMock).toHaveBeenCalledTimes(2)
      expect(setDisplayName).toHaveBeenCalledWith(workspaceId, 'Fix auth')
      if (workspaceId === FOLDER_WORKTREE_ID) {
        expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
      } else {
        expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
          ['branch', '-m', 'you/fix-auth'],
          expect.anything()
        )
      }
    }
  )

  it('does not probe git for a folder-project structured session with a synthetic worktree id', async () => {
    const workspaceId = `${REPO_ID}::/workspace/platform::workspace:123e4567-e89b-12d3-a456-426614174000`
    const { deps, setDisplayName, setRenameError } = makeDeps({
      getRepo: () => ({ id: REPO_ID, kind: 'folder', path: '/workspace/platform' }) as Repo
    })
    const items: AgentJournalRenderItem[] = [
      {
        itemId: 'user-1',
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Fix auth' }] }
      },
      {
        itemId: 'turn-1',
        sequence: 2,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'status',
          text: 'Working',
          turnLifecycle: { turnId: 'turn-1', state: 'running' }
        }
      }
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status feed uses these held rows and provenance reads; the item lookup is checked against the real journal contract.
    const journal = {
      lastActivityAt: () => 1,
      context: { floor: () => null },
      stopMarks: { latest: () => null, revision: () => 0 },
      cursor: () => ({ epoch: 1, sequence: 1 }),
      snapshot: () => ({ items, submissions: [] }),
      item: ((itemId) =>
        items.find((item) => item.itemId === itemId) ?? null) satisfies AgentSessionJournal['item'],
      itemFence: () => undefined,
      wroteBeforeOpen: () => false,
      runningTurn: () => null
    } as unknown as AgentSessionJournal
    const location = {
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId,
      workspaceKind: 'git-worktree' as const
    }
    const pending: Promise<void>[] = []
    const feed = new StructuredAgentSessionStatusFeed({
      logger: createStructuredAgentSessionLogger(),
      sessions: new Map([['session', { journal, params: { location, provider: 'codex' } }]]),
      getRecord: () => null,
      now: () => 1,
      onStatusChanged: (summary, options) => {
        expect(summary.workspaceId).toBe(workspaceId)
        const work = maybeAutoRenameWorkspaceOnFirstStructuredTurn(summary, options, deps)
        if (work) {
          pending.push(work)
        }
      }
    })

    feed.publish('session', journal)
    await Promise.all(pending)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setRenameError).toHaveBeenCalledWith(workspaceId, null)
  })

  it('keeps incidental work-item markers from overriding the generated display name', async () => {
    const { deps, onRenamed, setDisplayName } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ prompt: 'Fix auth from note #1' }), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(resolveTextGenerationParamsMock).toHaveBeenCalledWith(
      expect.anything(),
      'local',
      'branchName',
      expect.objectContaining({ id: REPO_ID })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Fix auth')
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('asks to align the on-disk folder with the generated slug after renaming', async () => {
    const { deps, renameWorktreeFolder } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(renameWorktreeFolder).toHaveBeenCalledWith(WORKTREE_ID, 'fix-auth')
  })

  it('keeps branch and display rename working when folder rename is disabled', async () => {
    const { deps, onRenamed, setDisplayName } = makeDeps({ renameWorktreeFolder: undefined })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Fix auth')
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('skips the redundant branch-rename notify when the folder rename succeeded', async () => {
    const { deps, onRenamed } = makeDeps({ renameWorktreeFolder: vi.fn(async () => true) })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('survives a folder-rename failure without undoing the branch/display rename', async () => {
    const { deps, onRenamed, setDisplayName } = makeDeps({
      renameWorktreeFolder: vi.fn(async () => {
        throw new Error('git worktree move failed')
      })
    })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Fix auth')
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('strips a prefix the model leaked into the slug from both branch and display name', async () => {
    // Sanitization folds an echoed you/ prefix into the slug; strip it to prevent double-prefixing.
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'you-worktree-spinner' })
    const { deps, setDisplayName } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/worktree-spinner'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Worktree spinner')
  })

  it('skips the rename when the model echoes only the configured prefix', async () => {
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'you' })
    const { deps, onRenamed, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['branch', '-m', expect.anything()],
      expect.anything()
    )
    expect(onRenamed).not.toHaveBeenCalled()
    expect(setRenameError).not.toHaveBeenCalledWith(WORKTREE_ID, expect.any(String))
  })

  it('leaves a user-customized display name untouched while still renaming the branch', async () => {
    const { deps, setDisplayName } = makeDeps({ getCurrentDisplayName: () => 'My cool feature' })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).not.toHaveBeenCalled()
  })

  it('runs Git against the backing folder for a folder-workspace instance id', async () => {
    const instanceId = `${WORKTREE_ID}::workspace:123e4567-e89b-12d3-a456-426614174000`
    const { deps } = makeDeps({ resolveWorktreeIdForTab: () => instanceId })
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ worktreeId: undefined }), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
  })

  it('skips when no worktree can be resolved for the tab', async () => {
    const { deps } = makeDeps({ resolveWorktreeIdForTab: () => undefined })
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ worktreeId: undefined }), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does nothing when the setting is off', async () => {
    const settings = { autoRenameBranchFromWork: false } as unknown as GlobalSettings
    const { deps } = makeDeps({ getSettings: () => settings })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('renames a pending folder workspace title without touching git', async () => {
    const { deps, onRenamed, setDisplayName } = makeDeps({
      resolveWorktreeIdForTab: () => FOLDER_WORKTREE_ID,
      getFolderWorkspacePath: () => '/workspace/platform',
      isPendingFirstAgentMessageRename: () => true,
      getCurrentDisplayName: () => 'Platform workspace'
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent({ prompt: 'Fix auth from note #1' }), deps)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(resolveTextGenerationParamsMock).toHaveBeenCalledWith(
      expect.anything(),
      'local',
      'branchName',
      null
    )
    expect(setDisplayName).toHaveBeenCalledWith(FOLDER_WORKTREE_ID, 'Fix auth')
    expect(onRenamed).toHaveBeenCalledWith(FOLDER_WORKTREE_ID)
  })

  it.each([true, false])(
    'preserves a manual folder name during generation (pending=%s)',
    async (pendingAfterRename) => {
      let name = 'Platform workspace'
      let pending = true
      const { deps, setDisplayName } = makeDeps({
        resolveWorktreeIdForTab: () => FOLDER_WORKTREE_ID,
        getFolderWorkspacePath: () => '/workspace/platform',
        isPendingFirstAgentMessageRename: () => pending,
        getCurrentDisplayName: () => name
      })
      generateBranchNameMock.mockImplementationOnce(async () => {
        name = 'My manual title'
        pending = pendingAfterRename
        return { success: true, slug: 'fix-auth' }
      })

      await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

      expect(generateBranchNameMock).toHaveBeenCalledOnce()
      expect(setDisplayName).not.toHaveBeenCalled()
    }
  )

  it('does not rename folder workspace titles without the pending marker', async () => {
    const { deps, setDisplayName } = makeDeps({
      resolveWorktreeIdForTab: () => FOLDER_WORKTREE_ID,
      getFolderWorkspacePath: () => '/workspace/platform',
      isPendingFirstAgentMessageRename: () => false
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
  })

  it('ignores replayed events and non-working states', async () => {
    const { deps } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ isReplay: true }), deps)
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ state: 'done' }), deps)
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ prompt: '   ' }), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not re-attempt after a successful rename', async () => {
    const { deps } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    generateBranchNameMock.mockClear()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
  })

  it('bounds settled worktree dedupe while keeping recent entries', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/my-feature', hasUpstream: false })
    )
    const { deps } = makeDeps()
    const firstWorktreeId = `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt-0`
    const lastWorktreeId = `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt-${FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT}`

    for (let index = 0; index <= FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT; index += 1) {
      await maybeAutoRenameBranchOnFirstWork(
        workingEvent({
          tabId: undefined,
          paneKey: '',
          worktreeId: `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt-${index}`
        }),
        deps
      )
    }
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(
      FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT + 1
    )

    gitExecFileAsyncMock.mockClear()
    await maybeAutoRenameBranchOnFirstWork(
      workingEvent({ tabId: undefined, paneKey: '', worktreeId: firstWorktreeId }),
      deps
    )
    await maybeAutoRenameBranchOnFirstWork(
      workingEvent({ tabId: undefined, paneKey: '', worktreeId: lastWorktreeId }),
      deps
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ cwd: '/repo/wt-0' })
    )
  })

  it('retries on a later event after a transient failure (does not poison the worktree)', async () => {
    generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'agent not ready' })
    const { deps, onRenamed, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).not.toHaveBeenCalled()

    elapseGenerationBackoff()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
    expect(setRenameError).toHaveBeenLastCalledWith(WORKTREE_ID, null)
  })

  it('records a user-facing error and the full CLI output when generation fails', async () => {
    const failureOutput = { label: 'Pi', exitCode: 1, stdout: '', stderr: 'No API key found.' }
    generateBranchNameMock.mockResolvedValueOnce({
      success: false,
      error: 'agent not ready',
      failureOutput
    })
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, 'agent not ready', failureOutput)
  })

  it('records a user-facing error when no generation agent is configured', async () => {
    resolveTextGenerationParamsMock.mockReturnValueOnce({
      ok: false,
      error: 'No agent configured.'
    })
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, 'No agent configured.')
  })

  it('clears any stale error after a successful rename', async () => {
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, null)
  })

  it('leaves a user-named branch untouched', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/my-feature', hasUpstream: false })
    )
    const { deps, onRenamed, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
    expect(setRenameError).not.toHaveBeenCalledWith(WORKTREE_ID, expect.any(String))
  })

  it('clears a stale error when a retryable worktree later reaches a benign stop', async () => {
    generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'agent not ready' })
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, 'agent not ready', null)

    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: true })
    )
    elapseGenerationBackoff()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenLastCalledWith(WORKTREE_ID, null)
  })

  it('backs off a generation that keeps hitting a usage limit, then recovers (#9705)', async () => {
    const error = "You've hit your session limit · resets 2pm"
    generateBranchNameMock.mockResolvedValue({ success: false, error })
    const { deps, onRenamed, setRenameError } = makeDeps()
    for (let minute = 0; minute < 60; minute++) {
      clockMs = minute * 60_000
      for (let event = 0; event < 5; event++) {
        await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
      }
    }
    // 300 working events over an hour; attempts only at minutes 0, 1 (+30s), 3 (+2m) and 33 (+30m).
    expect(generateBranchNameMock).toHaveBeenCalledTimes(4)
    expect(onRenamed).not.toHaveBeenCalled()
    expect(setRenameError).toHaveBeenLastCalledWith(WORKTREE_ID, error, null)

    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-auth' })
    clockMs = 63 * 60_000
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('does not raise the failure badge when generation is canceled by the user', async () => {
    generateBranchNameMock.mockResolvedValueOnce({
      success: false,
      error: 'Generation canceled.',
      canceled: true
    })
    const { deps, setRenameError, setDisplayName, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'branch')).toBe(false)
    expect(setRenameError).not.toHaveBeenCalledWith(WORKTREE_ID, 'Generation canceled.')
  })

  it('refuses to rename a branch that already has an upstream', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: true })
    )
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('surfaces a failed upstream probe and retries instead of settling silently (issue #7808)', async () => {
    // Localized probe failures must remain visible and retryable.
    const localizedError = new Error(
      'Command failed: git rev-parse --abbrev-ref HEAD@{u}\n' +
        "Schwerwiegend: Kein Upstream-Branch für Branch 'you/Nautilus' konfiguriert."
    )
    const plainResponder = gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: false })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.some((arg) => arg.includes('@{u}'))) {
        throw localizedError
      }
      return plainResponder(args)
    })
    const { deps, onRenamed, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
    expect(setRenameError).toHaveBeenCalledWith(
      WORKTREE_ID,
      expect.stringContaining('Schwerwiegend')
    )

    gitExecFileAsyncMock.mockImplementation(plainResponder)
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setRenameError).toHaveBeenLastCalledWith(WORKTREE_ID, null)
  })

  it('leaves ineligible branches untouched even when their leaf is a creature name', async () => {
    const { deps, onRenamed } = makeDeps({ canRenameOrcaCreatedBranch: () => false })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('suffixes the branch, display name, and folder together on collision', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({
        currentBranch: 'you/Nautilus',
        hasUpstream: false,
        existingRefs: ['refs/heads/you/fix-auth']
      })
    )
    const { deps, setDisplayName, renameWorktreeFolder } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth-2'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Fix auth 2')
    expect(renameWorktreeFolder).toHaveBeenCalledWith(WORKTREE_ID, 'fix-auth-2')
  })

  it('does not rename when the branch changes while generation is running', async () => {
    let branchReadCount = 0
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        branchReadCount += 1
        return { stdout: `${branchReadCount === 1 ? 'you/Nautilus' : 'you/manual'}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.includes('@{u}'))) {
        throw noUpstreamError
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/you/Nautilus')) {
        throw new Error('not found')
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.anything()
    )
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
    expect(branchReadCount).toBe(2)
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('does not rename when the branch gains an upstream while generation is running', async () => {
    let upstreamReadCount = 0
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return { stdout: 'you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.includes('@{u}'))) {
        upstreamReadCount += 1
        if (upstreamReadCount === 1) {
          throw noUpstreamError
        }
        return { stdout: 'origin/you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/you/Nautilus')) {
        throw new Error('not found')
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.anything()
    )
    expect(generateBranchNameMock).toHaveBeenCalledTimes(1)
    expect(upstreamReadCount).toBe(2)
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it.each<[string, Repo]>([
    ['connectionId', { ...REMOTE_REPO_BASE, connectionId: 'ssh-1' }],
    ['executionHostId', { ...REMOTE_REPO_BASE, executionHostId: 'ssh:ssh-1' }]
  ])(
    'skips local generation and git for a row naming its SSH owner by %s',
    async (_spelling, repo) => {
      const { deps, onRenamed } = makeDeps({ getRepo: () => repo })

      await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
      expect(generateBranchNameMock).not.toHaveBeenCalled()
      expect(onRenamed).not.toHaveBeenCalled()
    }
  )

  it("never dials a paired server's nested SSH target from this client", async () => {
    const repo: Repo = {
      ...REMOTE_REPO_BASE,
      connectionId: 'ssh-1',
      executionHostId: 'runtime:env-1'
    }
    const { deps, onRenamed } = makeDeps({ getRepo: () => repo })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })
})
