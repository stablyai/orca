import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type {
  AgentJournalSnapshot,
  AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { readStructuredSessionRecovery } from './structured-agent-session-recovery-read'
import * as recoveryOptions from '../../runtime/structured-session-recovery-options'

it('does no discovery on ordinary reads and drops preparation superseded by a send', async () => {
  const prepare = vi.spyOn(recoveryOptions, 'structuredSessionRecoveryOptions')
  const record = agentSessionRecordFixture()
  const snapshot: AgentJournalSnapshot = {
    sessionId: record.sessionId,
    cursor: { epoch: 'epoch', sequence: 1 },
    items: [],
    submissions: []
  }
  const session = { journal: { snapshot: () => snapshot } }
  const deps = {
    store: { getRecord: () => record },
    journalDatabase: { stateDirectory: '/state' },
    resolveLaunchEnv: vi.fn(() => ({})),
    resolveWorkspacePath: vi.fn(async () => '/workspace')
  }
  const context = { deps, conversation: async () => session }
  expect(await readStructuredSessionRecovery(session, context, record.sessionId)).toEqual({
    canSwitchAccount: false
  })
  expect(prepare).not.toHaveBeenCalled()
  expect(deps.resolveLaunchEnv).not.toHaveBeenCalled()
  expect(deps.resolveWorkspacePath).not.toHaveBeenCalled()
  const bodies: AgentJournalItemBody[] = [
    {
      kind: 'turn',
      turnId: 'turn',
      state: 'completed',
      outcome: 'failure',
      startedAt: 1,
      completedAt: 2
    },
    {
      kind: 'status',
      ...agentSessionFailureWords({ kind: 'usageLimitReached' }, { surface: 'row' })
    }
  ]
  snapshot.items = bodies.map((body, sequence) => ({
    itemId: sequence ? 'limit' : 'turn',
    sequence,
    revision: 1,
    observedAt: 1,
    body,
    ...(sequence ? { turnScope: { kind: 'turn' as const, turnItemId: 'turn' } } : {})
  }))
  const preparation = Promise.withResolvers<{ canSwitchAccount: boolean; transcriptPath: string }>()
  prepare.mockReturnValue(preparation.promise)
  const pending = readStructuredSessionRecovery(session, context, record.sessionId)
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  snapshot.items = []
  preparation.resolve({ canSwitchAccount: true, transcriptPath: '/old-context' })
  expect(await pending).toEqual({ canSwitchAccount: false })
  prepare.mockRestore()
})

it('recovers an unpinned OMP native file using the owning host directory and floating pin policy', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'usage-limit-actions-omp-')))
  try {
    const cwd = join(root, 'workspace')
    const account = join(root, 'account')
    const bucket = join(account, 'sessions', '-workspace')
    await mkdir(cwd)
    await mkdir(bucket, { recursive: true })
    const nativeId = '01a15cd7-6dea-7000-a282-25e88a10ede4'
    const transcript = join(bucket, `2026-10-21T05-03-04-682Z_${nativeId}.jsonl`)
    // Captured OMP native header shape; only the owning directory is relocated for isolation.
    await writeFile(
      transcript,
      `${JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: '2026-10-21T05:03:04.682Z' })}\n${JSON.stringify({ type: 'session', version: 3, id: nativeId, timestamp: '2026-10-21T05:03:04.682Z', cwd })}\n`
    )
    const record = agentSessionRecordFixture()
    record.provider = 'omp'
    record.accountHome = { variable: 'PI_CODING_AGENT_DIR', path: account }
    record.providerHandleChain[0].handle = { transport: 'acp', agent: 'omp', nativeId }
    const bodies: AgentJournalItemBody[] = [
      {
        kind: 'turn',
        turnId: 'turn',
        state: 'completed',
        outcome: 'failure',
        startedAt: 1,
        completedAt: 2
      },
      {
        kind: 'status',
        ...agentSessionFailureWords({ kind: 'usageLimitReached' }, { surface: 'row' })
      }
    ]
    const snapshot: AgentJournalSnapshot = {
      sessionId: record.sessionId,
      cursor: { epoch: 'epoch', sequence: 1 },
      items: bodies.map((body, sequence) => ({
        itemId: sequence ? 'limit' : 'turn',
        sequence,
        revision: 1,
        observedAt: 1,
        body,
        ...(sequence ? { turnScope: { kind: 'turn' as const, turnItemId: 'turn' } } : {})
      })),
      submissions: []
    }
    const session = { journal: { snapshot: () => snapshot } }
    const resolveWorkspacePath = vi.fn(async () => cwd)
    const deps = {
      store: { getRecord: () => record },
      resolveWorkspacePath,
      resolveLaunchEnv: () => ({
        HOME: root,
        USERPROFILE: root,
        OMP_CODING_AGENT_DIR: join(account, 'sessions')
      })
    }
    const read = () =>
      readStructuredSessionRecovery(
        session,
        { deps, conversation: async () => session },
        record.sessionId
      )
    const expected = { canSwitchAccount: false, transcriptPath: transcript }
    expect(record.launchDirectory).toBeUndefined()
    expect(await read()).toEqual(expected)
    expect(resolveWorkspacePath).toHaveBeenLastCalledWith(record.location.workspaceId)
    record.location = {
      ...record.location,
      workspaceId: 'folder:adopted-workspace',
      workspaceKind: 'folder'
    }
    expect(await read()).toEqual(expected)
    // Ordinary workspaces follow the host directory even when an old pin remains.
    record.launchDirectory = join(root, 'old-directory')
    expect(await read()).toEqual(expected)
    record.location.workspaceId = FLOATING_TERMINAL_WORKTREE_ID
    record.launchDirectory = cwd
    resolveWorkspacePath.mockClear()
    resolveWorkspacePath.mockResolvedValue(join(root, 'changed-floating-setting'))
    expect(await read()).toEqual(expected)
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
