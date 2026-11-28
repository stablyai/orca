import { expect, it, vi } from 'vitest'
import type { AgentChatPermissionChoice } from '../../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { formatOrcaSessionAddress } from '../../../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { refuse } from '../../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionConversationView } from '../../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { StructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrchestrationSessionCaller } from '../../../../../orchestration/addressing/orchestration-caller-identity'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import { planWorkerFollowUp, startWorkerFollowUp } from '../../messaging/worker-follow-up'
import { createWorkerReleaseFixture, isStartReceipt } from '../release/worker-release.test-fixture'
import { startWorker } from '../worker-start-method'

const SESSION = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const ADDRESS = formatOrcaSessionAddress(SESSION)
const WORKSPACE = 'repo::worktree'

type Case = {
  name: string
  saved?: AgentChatPermissionChoice
  running?: AgentChatPermissionChoice
  launched?: AgentChatPermissionChoice
  requiresAcquisition?: boolean
  global: 'ask' | 'full-access'
  expected: AgentChatPermissionChoice | undefined
  coordinator?: 'claude'
  worker?: 'claude' | 'codex' | 'pi'
  terminalCaller?: boolean
  switchAfterStart?: boolean
  followUp?: boolean
}

it.each<Case>([
  { name: 'Full access', saved: 'full-access', global: 'ask', expected: 'full-access' },
  { name: 'Ask under global Full access', saved: 'ask', global: 'full-access', expected: 'ask' },
  {
    name: 'an Ask follow-up that starts fresh under global Full access',
    saved: 'ask',
    global: 'full-access',
    expected: 'ask',
    followUp: true
  },
  {
    name: 'Accept Edits for a worker that lacks it',
    saved: 'accept-edits',
    worker: 'codex',
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'agent settings for the same agent',
    saved: 'own',
    global: 'full-access',
    expected: 'own'
  },
  {
    name: 'agent settings for a different agent',
    saved: 'own',
    worker: 'codex',
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'Claude settings for a Claude worker when Claude reports Accept Edits',
    coordinator: 'claude',
    worker: 'claude',
    saved: 'own',
    running: 'accept-edits',
    global: 'full-access',
    expected: 'own'
  },
  {
    name: 'Claude settings for a Codex worker when Claude reports Accept Edits',
    coordinator: 'claude',
    worker: 'codex',
    saved: 'own',
    running: 'accept-edits',
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'Claude settings launched as own when Claude reports Accept Edits',
    coordinator: 'claude',
    worker: 'claude',
    saved: 'own',
    running: 'accept-edits',
    launched: 'own',
    global: 'full-access',
    expected: 'own'
  },
  {
    name: 'a switch from Ask to agent settings that requires acquisition',
    coordinator: 'claude',
    worker: 'claude',
    saved: 'own',
    running: 'ask',
    launched: 'own',
    requiresAcquisition: true,
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'a switch to agent settings after launching with Ask without an acquisition report',
    saved: 'own',
    launched: 'ask',
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'Full access that still requires acquisition despite the running mode report',
    saved: 'full-access',
    running: 'full-access',
    launched: 'full-access',
    requiresAcquisition: true,
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'a pending switch to Full access',
    saved: 'full-access',
    running: 'ask',
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'a pending switch to Ask',
    saved: 'ask',
    running: 'full-access',
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'a pending switch to Full access without an adapter report',
    coordinator: 'claude',
    saved: 'full-access',
    launched: 'ask',
    global: 'full-access',
    expected: 'ask'
  },
  {
    name: 'a mode picked after the start',
    saved: 'full-access',
    running: 'full-access',
    global: 'ask',
    expected: 'full-access',
    switchAfterStart: true
  },
  {
    name: 'a terminal caller',
    saved: 'ask',
    global: 'full-access',
    expected: 'full-access',
    terminalCaller: true
  },
  { name: 'a chat with no saved mode', global: 'full-access', expected: 'ask' },
  {
    name: 'a worker with no permission modes',
    saved: 'ask',
    worker: 'pi',
    global: 'full-access',
    expected: undefined
  }
])('seeds the new worker chat for $name', async (scenario) => {
  const { db, runtime } = createWorkerReleaseFixture()
  const agent = scenario.worker ?? 'antigravity'
  const record = {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: SESSION })),
    provider: scenario.coordinator ?? 'antigravity',
    permissionMode: scenario.saved
  }
  const caller: OrchestrationSessionCaller = {
    address: ADDRESS,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: SESSION,
    sessionId: SESSION,
    workspaceId: WORKSPACE
  }
  const create = vi.fn<StructuredAgentSessionHost['create']>().mockResolvedValue({
    ok: false,
    refusal: refuse(
      'agent_session_operation_invalid',
      { reason: 'requestMalformed' },
      'Test stops at chat creation.'
    )
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies only the settings read by worker and chat seeding.
  vi.spyOn(runtime, 'requireStore').mockReturnValue({
    getSettings: () => ({
      nativeChatPermissionMode: scenario.global,
      nativeChatProviders: { [agent]: true }
    })
  } as never)
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(
    async ({ envelope, agent: provider }) => ({
      envelope: { ...envelope, expectedRuntimeFence: null, payloadFingerprint: '' },
      provider,
      agent: provider,
      runtimeKind: 'native',
      location: { ...record.location, workspaceId: WORKSPACE },
      accountHome: record.accountHome,
      options: runtime.structuredAgentSessionLaunchSeedOptions(provider)
    })
  )
  const host = {
    create,
    captureAgentStartDestination: () => null,
    publishBackgroundTasks: () => {},
    reads: { childLaunchPermissionMode: () => scenario.launched },
    deps: {
      adapter: {
        runningPermissionMode: () => scenario.running,
        permissionModeRequiresAcquisition: () => scenario.requiresAcquisition
      },
      store: {
        getRecord: (id: string) => (id === SESSION ? record : null),
        getConversation: (id: string) =>
          id === SESSION ? agentSessionConversationView(record) : null,
        listConversations: () => [agentSessionConversationView(record)],
        getOperationRow: () => null
      },
      agents: { definition: () => ({}) }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub ends the launch at host create and supplies the reads made before it.
  setStructuredAgentSessionHost(host as never)
  try {
    const started = startWorker(
      { from: scenario.terminalCaller ? 'term_coord' : ADDRESS, spec: 'Do work', agent },
      { runtime, orchestrationCaller: scenario.terminalCaller ? undefined : caller }
    )
    if (scenario.switchAfterStart) {
      record.permissionMode = 'ask'
    }
    const receipt = await started
    expect(receipt).toMatchObject({ mode: { mode: 'structured' } })
    if (scenario.followUp) {
      // The refused create leaves a settled Dispatch without a conversation to reopen.
      if (!isStartReceipt(receipt)) {
        throw new Error('Missing the previous worker Dispatch')
      }
      const plan = planWorkerFollowUp(db, receipt.dispatchId, 'dispatch')
      if (plan?.kind !== 'start') {
        throw new Error('Expected the previous worker Dispatch to admit a follow-up')
      }
      const followUp = await startWorkerFollowUp({
        ctx: { runtime, orchestrationCaller: caller },
        db,
        plan,
        from: ADDRESS,
        message: { subject: 'Continue the work' }
      })
      expect(followUp).toMatchObject({
        kind: 'started',
        receipt: { delivery: 'started_fresh', mode: { mode: 'structured' } }
      })
    }
    expect(create).toHaveBeenCalledTimes(scenario.followUp ? 2 : 1)
    expect(create.mock.lastCall?.[1].options?.permissionMode).toBe(scenario.expected)
  } finally {
    setStructuredAgentSessionHost(null)
    db.close()
    vi.restoreAllMocks()
  }
})
