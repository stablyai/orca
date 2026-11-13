import { expect, it, vi } from 'vitest'
import { runtimeFixture } from './worker-quiet-runtime.test-fixture'
import { OrcaRuntimeWithGetWorktreePs } from '../../../workspaces/process-listing/workspace-process-listing'
import { ensureStructuredAgentSessionHost } from '../../../agent-session/structured-agent-session-runtime'

vi.mock('../turn-stops/chat-worker-runtime-events', () => ({ RuntimeChatWorkerEvents: class {} }))
vi.mock('../../../agent-session/structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn()
}))
vi.mock('../../../agent-session/naming/structured-chat-naming-runtime', () => ({
  structuredChatNamingDeps: () => ({})
}))
vi.mock('../../../../native-chat/structured-chat-naming', () => ({
  createStructuredChatNamingHandler: () => () => {}
}))
vi.mock('../../../../agent-hooks/first-work/first-work-rename-runtime', () => ({
  firstWorkRenameDeps: () => ({})
}))
vi.mock('../../../../agent-hooks/first-work/first-work-structured-session-rename', () => ({
  maybeAutoRenameWorkspaceOnFirstStructuredTurn: async () => {}
}))

const fixture = runtimeFixture()

it('wakes an idle watch from the chat host status projection and stops polling an idle chat', async () => {
  const { db, chat, changes } = fixture
  const { run } = fixture.workers(1)
  chat.status = 'idle'
  fixture.start()
  vi.advanceTimersByTime(120_000)
  expect(chat.progress).not.toHaveBeenCalled()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: register the real host callbacks without constructing runtime services or starting a provider; host installation is captured below.
  const runtime = Object.assign(Object.create(OrcaRuntimeWithGetWorktreePs.prototype), {
    crewChanges: changes,
    requireStore: () => ({}),
    structuredAgentCatalogDependencies: () => ({ stateDirectory: '/unused' }),
    agentSessionClaimSigner: { keyId: 'test' },
    usageLimitAutoContinueHostDeps: () => ({}),
    mobileNotifications: { dispatch: () => {}, reconcileStructuredPromptAttention: () => {} },
    workerAutoReleaseActivity: { observeChat: () => {} },
    onStructuredSessionStatusForMail: () => {},
    startPullRequestWatches: () => {}
  }) as OrcaRuntimeWithGetWorktreePs
  await runtime.ensureStructuredAgentSessionHost()
  const projection = vi
    .mocked(ensureStructuredAgentSessionHost)
    .mock.calls.at(-1)![0].onSessionStatusChanged!
  const summary = {
    sessionId: 'term_worker_0',
    workspaceId: 'workspace',
    agent: 'codex' as const,
    latestPrompt: 'work',
    updatedAt: 0
  }
  chat.status = 'working'
  projection({ ...summary, status: 'working' }, { replay: false })
  vi.advanceTimersByTime(900_000)
  expect(db.getUnreadRunMailbox(run.id, 100, ['status'])).toHaveLength(1)
  chat.status = 'idle'
  projection({ ...summary, status: 'idle' }, { replay: false })
  vi.advanceTimersByTime(60_000)
  chat.progress.mockClear()
  vi.advanceTimersByTime(600_000)
  expect(chat.progress).not.toHaveBeenCalled()
  expect(db.getUnreadRunMailbox(run.id, 100, ['status'])).toHaveLength(1)
})
