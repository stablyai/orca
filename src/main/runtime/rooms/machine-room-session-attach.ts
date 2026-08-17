import { randomUUID } from 'node:crypto'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredMachineAgent } from '../../../shared/structured-agent-provider'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../../native-chat/agent-session-wire/structured-agent-session-attach'
import type {
  RoomHarnessLaunchOptions,
  RoomHarnessRuntime,
  RoomMachineHarnessBinding
} from './harness-adapter-types'
import { applyMachineRoomPreferences } from './machine-room-session-observation'
import {
  createRoomMachineBinding,
  structuredRoomCaller,
  structuredRoomHolderId,
  structuredRoomHost,
  structuredRoomMutationEnvelope,
  structuredRoomOperationId
} from './machine-harness-session'

export async function attachMachineRoomSession(input: {
  agent: StructuredMachineAgent
  runtime: RoomHarnessRuntime
  worktreeId: string
  options?: RoomHarnessLaunchOptions
  providerSessionId?: string
  emptyRecord?: AgentSessionRecord
}): Promise<RoomMachineHarnessBinding> {
  const { agent, runtime, worktreeId, options, providerSessionId, emptyRecord } = input
  const sessionId = `room_${randomUUID().replaceAll('-', '_')}`
  const ensureHost = runtime.ensureStructuredAgentSessionHost?.bind(runtime)
  const resolveIntent = runtime.resolveStructuredAgentSessionCreateIntent?.bind(runtime)
  if (!ensureHost || (!emptyRecord && !resolveIntent)) {
    throw new Error('structured_agent_session_unsupported')
  }
  await ensureHost()
  const params: AgentSessionAttachParams = emptyRecord
    ? {
        envelope: {
          sessionId,
          clientOperationId: structuredRoomOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        },
        location: emptyRecord.location,
        accountHome: emptyRecord.accountHome,
        provider: emptyRecord.provider,
        agent,
        runtimeKind: 'native'
      }
    : await resolveIntent!({
        envelope: { sessionId, clientOperationId: structuredRoomOperationId() },
        worktree: `id:${worktreeId}`,
        agent,
        ...(providerSessionId ? { providerSessionId } : {})
      })
  params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
    method: 'agentSession.attach',
    sessionId,
    fields: attachFingerprintFields(params)
  })
  const host = structuredRoomHost()
  const result = await host.attach({ callerKey: `trusted-local:room:${worktreeId}` }, params)
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  const created = createRoomMachineBinding(worktreeId, sessionId, 'created', providerSessionId)
  try {
    await host.hold(sessionId, structuredRoomHolderId(created))
    const { model, ...otherOptions } = emptyRecord?.options ?? {}
    for (const [key, value] of Object.entries({ ...(model ? { model } : {}), ...otherOptions })) {
      const result = await host.setOption(structuredRoomCaller(created), {
        envelope: structuredRoomMutationEnvelope(sessionId, 'agentSession.setOption', {
          key,
          value
        }),
        key,
        value
      })
      if (!result.ok) {
        throw new Error(result.refusal.message)
      }
    }
    await applyMachineRoomPreferences(created, options?.preferences)
    return created
  } catch (error) {
    await host.close(sessionId).catch(() => undefined)
    throw error
  }
}
