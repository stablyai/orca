import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type * as CommitMessageTextGenerationModule from '../text-generation/commit-message-text-generation'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from './first-work-structured-session-rename'
import '../../shared/worktree/id'

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

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: resolveLocalGitUsernameMock }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: generateBranchNameMock,
  resolveTextGenerationParams: resolveTextGenerationParamsMock
}))
await vi.importActual<typeof CommitMessageTextGenerationModule>(
  '../text-generation/commit-message-text-generation'
)
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: prepareLocalEnvMock
}))
vi.mock('../ipc/worktree-branch-name', () => ({
  computeBranchName: computeBranchNameMock,
  getConfiguredBranchPrefix: getConfiguredBranchPrefixMock
}))
import {
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
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'

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

const journals = createTrackedJournalOpener()
const roots: string[] = []
afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function renameJournal(agent: 'claude' | 'codex', workspaceId: string) {
  const root = await mkdtemp(join(tmpdir(), 'orca-first-work-sql-'))
  roots.push(root)
  return journals.open({
    stateDirectory: root,
    identity: {
      sessionId: 'session',
      workspaceId,
      hostId: 'local',
      agent,
      providerHandle:
        agent === 'claude' ? claudeProviderHandle('native', null) : codexProviderHandle('native')
    }
  })
}

const USER = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Fix auth' }]
} satisfies AgentJournalItemBody
const TURN = {
  kind: 'status',
  text: 'Working',
  turnLifecycle: { turnId: 'turn-1', state: 'running' }
} satisfies AgentJournalItemBody

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
      const journal = await renameJournal(agent, workspaceId)
      const userIdentity =
        agent === 'claude'
          ? { provider: 'claude' as const, sessionId: 'native', uuid: 'user' }
          : { provider: 'codex' as const, threadId: 'native', turnId: 'turn-1', ordinal: 0 }
      const turnIdentity =
        agent === 'claude'
          ? { provider: 'claude' as const, sessionId: 'native', uuid: 'turn' }
          : { provider: 'codex' as const, threadId: 'native', turnId: 'turn-1', ordinal: 1 }
      const appendTurn = () =>
        journal.appendItem(turnIdentity, TURN, { fence: 0, turnScope: { kind: 'thread' } })
      const removeTurn = () => journal.appendTombstone(turnIdentity, { fence: 0 })
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
        getConversation: () => null,
        now: () => 1,
        onStatusChanged: observe
      })
      await journal.appendItem(userIdentity, USER, { fence: 0, turnScope: { kind: 'thread' } })
      await appendTurn()
      await feed.publish('session', journal, { replay: true })
      await Promise.all(pending)
      expect(gitExecFileAsyncMock).not.toHaveBeenCalled()

      await removeTurn()
      await feed.publish('session', journal)
      await appendTurn()
      generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'temporary failure' })
      await feed.publish('session', journal)
      await Promise.all(pending)
      expect(generateBranchNameMock).toHaveBeenCalledOnce()
      expect(setDisplayName).not.toHaveBeenCalled()
      await feed.publish('session', journal)
      expect(generateBranchNameMock).toHaveBeenCalledOnce()

      elapseGenerationBackoff()
      await removeTurn()
      await feed.publish('session', journal)
      await appendTurn()
      await feed.publish('session', journal)
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
    const journal = await renameJournal('codex', workspaceId)
    for (const [ordinal, body] of [USER, TURN].entries()) {
      await journal.appendItem(
        { provider: 'codex', threadId: 'native', turnId: 'turn-1', ordinal },
        body,
        { fence: 0, turnScope: { kind: 'thread' } }
      )
    }
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
      getConversation: () => null,
      now: () => 1,
      onStatusChanged: (summary, options) => {
        expect(summary.workspaceId).toBe(workspaceId)
        const work = maybeAutoRenameWorkspaceOnFirstStructuredTurn(summary, options, deps)
        if (work) {
          pending.push(work)
        }
      }
    })

    await feed.publish('session', journal)
    await Promise.all(pending)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setRenameError).toHaveBeenCalledWith(workspaceId, null)
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
        return { stdout: 'refs/heads/you/Nautilus\n', stderr: '' }
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
        return { stdout: 'refs/heads/you/Nautilus\n', stderr: '' }
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
