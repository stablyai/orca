import { z } from 'zod'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionProviderHandleKey } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { messageText } from '../../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/providers/structured-agent-registry'
import {
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { AgentSessionRecoveryCapsule } from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { openTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type {
  AcpScriptedAgent,
  FakeFrame
} from '../../process/testing/acp-scripted-agent.test-support'
import { GROK, openAcpAdapterRig, PROVIDER_SESSION } from './acp-structured-adapter.test-support'
import type { FakeAcpChild } from '../../process/testing/acp-scripted-connection.test-fixture'
import {
  ACP_HANDLE_TRANSPORT,
  acpStructuredAgentDefinition
} from '../acp-structured-agent-definitions'
import type { AcpLaunchSpec } from '../../launch/acp-launch-contract'
import type { AcpStructuredLaunch } from '../../launch/acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from '../acp-structured-session-adapter-deps'
import type { AgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import type { StructuredAgentSessionHostDeps } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type { StructuredAgentSessionStatusSink } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-status-ownership'

export const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

export const attachParams = (fence: number | null = null) =>
  hostTestAttachParams(fence, {
    provider: 'grok',
    agent: 'grok',
    accountHome: { variable: 'GROK_HOME', path: '/grok' },
    providerHandle: undefined
  })

export function launch(resume: () => boolean, spec = GROK): () => Promise<AcpStructuredLaunch> {
  return async () => ({
    spec,
    command: '/fake/grok',
    prefixArgs: [],
    args: [],
    cwd: '/workspace',
    env: {},
    envToDelete: [],
    fullAccess: false,
    resume: resume()
      ? {
          sessionId: PROVIDER_SESSION,
          key: agentSessionProviderHandleKey({
            transport: ACP_HANDLE_TRANSPORT,
            agent: spec.agent,
            nativeId: PROVIDER_SESSION
          }),
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      : null
  })
}

export async function openHostRig(
  options: {
    spec?: AcpLaunchSpec
    script?: (agent: AcpScriptedAgent) => void
    initialize?: Record<string, unknown>
    deps?: Partial<AcpStructuredSessionAdapterDeps>
    modelCatalog?: AgentModelCatalogService
    statusSink?: StructuredAgentSessionStatusSink
    onRequestFailure?: StructuredAgentSessionHostDeps['onRequestFailure']
  } = {}
) {
  const state = hostTestState()
  const store = await openTestAgentSessionRecordStore(state.root)
  let generation = 0
  // Forward lifecycle and late-send settlements as the runtime does.
  const hosted: { host: StructuredAgentSessionHost | null } = { host: null }
  const journalDatabase = openTestJournalHostDatabase(state.root)
  const rig = await openAcpAdapterRig({
    ...options,
    deps: {
      onEvent: (event) => void hosted.host?.handleAdapterEvent(event),
      onChildWorkEvidence: (sessionId, evidence) =>
        hosted.host?.publishChildWorkEvidence(sessionId, evidence),
      onDispatchSettledLate: (settlement) =>
        void hosted.host
          ?.settleLateDispatch(settlement)
          .catch((error: unknown) =>
            state.log.logger.warn('late settlement failed', { scope: 'late-settlement', error })
          ),
      now: () => HOST_TEST_NOW,
      readProcessStartTime: async () => 1_700_000_000_000 + ++generation,
      mintGeneration: () => `generation-${generation}`,
      ...options.deps
    }
  })
  const host = new StructuredAgentSessionHost({
    agents: new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(options.spec ?? GROK), adapter: rig.adapter }
    ]),
    logger: state.log.logger,
    store,
    adapter: rig.adapter,
    journalDatabase,
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW,
    statusSink: options.statusSink,
    onRequestFailure: options.onRequestFailure,
    ...(options.modelCatalog ? { modelCatalog: options.modelCatalog } : {})
  })
  hosted.host = host
  replaceHostTestState({ store, host })
  const fence = () => store.getRecord(SESSION)?.lease.runtimeFence ?? 1

  const messages = async () =>
    (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
      .filter((row) => row.body.kind === 'message')
      .map((row) => messageText(row.body))

  return { rig, host, store, journalDatabase, fence, messages }
}

const promptMeta = z.object({ _meta: z.object({ promptId: z.string() }) })
export const promptIdOf = (frame: FakeFrame): string =>
  promptMeta.parse(frame.params)._meta.promptId

export function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

export async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = message(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  return sent.value.clientMessageId
}

export const framesOf = (child: FakeAcpChild, method: string) =>
  child.agent.frames.filter((frame) => frame.method === method)
