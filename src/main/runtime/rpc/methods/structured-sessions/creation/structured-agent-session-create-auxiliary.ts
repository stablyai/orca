import type { RpcContext } from '../../../core'
import type { z } from 'zod'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../../../../shared/agent-session/agent-session-wire'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode-option-id'
import { agentSessionFingerprintConflict } from '../../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { createAuxiliaryFingerprint } from '../../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import { activeProviderContext } from '../../../../../../shared/agent-session/conversation-context/agent-session-provider-context'
import { isAgentRpcCaller } from '../../../callers/rpc-caller-identity'
import type { CreateAuxiliaryParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import {
  resolveUncommittedStructuredCreate,
  type StructuredCreateRefused
} from './structured-agent-session-precommit-refusal'
import type { AgentSessionAttachParams } from '../../../../../native-chat/agent-session-wire/acquisition/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  AUXILIARY_CHAT_PROVIDERS,
  ompAuxiliaryParentWorking,
  resolveOmpAuxiliarySource
} from '../../../../../native-chat/agent-session-wire/acquisition/structured-agent-session-auxiliary-source'
import {
  OmpAuxiliaryDerivationError,
  deriveOmpAuxiliaryConversation,
  type OmpAuxiliaryConversation
} from '../../../../../omp/omp-auxiliary-conversation-derivation'
import { isFloatingWorkspaceId } from '../../../../../../shared/workspace/identity/floating-workspace-worktree'
import { projectReceiptDeviceAttach } from '../subscriptions/structured-agent-session-receipt-devices'
import {
  agentSessionRefusalError,
  refuse,
  type AgentSessionWireRefusal
} from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'

type DerivedAuxiliaryConversation = OmpAuxiliaryConversation

type PreparedAuxiliary = {
  host: StructuredAgentSessionHost
  attachParams: AgentSessionAttachParams
  derived: DerivedAuxiliaryConversation
  workspaceCwd: string
}

type AuxiliaryParent = Pick<
  AgentSessionRecord,
  'location' | 'accountHome' | 'options' | 'permissionMode' | 'launchArgs'
>

function auxiliaryDerivationRefusal(error: OmpAuxiliaryDerivationError): AgentSessionWireRefusal {
  switch (error.code) {
    case 'unstable-boundary':
      return refuse(
        'agent_session_operation_invalid',
        { reason: 'turnActive' },
        'The parent turn has no committed user message to derive from yet.'
      )
    case 'invalid-source':
    case 'session-mismatch':
      return refuse(
        'agent_session_identity_required',
        { reason: 'transcriptUnreadable' },
        error.message
      )
    case 'unsupported-version':
    case 'write-failed':
      return refuse(
        'structured_agent_session_unsupported',
        { reason: 'hostUnsupported' },
        error.message
      )
    default: {
      const exhaustive: never = error.code
      return exhaustive
    }
  }
}

/** Auxiliary creation is a desktop/web operation; phones and machine callers cannot see hidden children. */
function requireAuxiliaryAudience(ctx: RpcContext): void {
  // Desktop IPC and paired desktop/Web clients also use clientKind 'runtime'.
  if (ctx.clientKind === 'mobile' || !ctx.caller || isAgentRpcCaller(ctx.caller)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

function auxiliaryAttachParams(input: {
  params: z.infer<typeof CreateAuxiliaryParams>
  parent: AuxiliaryParent
  derived: DerivedAuxiliaryConversation
}): AgentSessionAttachParams {
  const { params, parent, derived } = input
  const options = buildParentOptions(parent)
  return {
    envelope: { ...params.envelope, expectedRuntimeFence: null },
    location: parent.location,
    provider: 'omp',
    agent: 'omp',
    accountHome: parent.accountHome,
    runtimeKind: 'native',
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(parent.launchArgs ? { launchArgs: [...parent.launchArgs] } : {}),
    seedProviderHandle: { transport: 'acp', agent: 'omp', nativeId: derived.sessionId },
    auxiliary: {
      parentSessionId: params.parentSessionId,
      nativeSessionId: derived.sessionId,
      nativeFilePath: derived.filePath
    }
  }
}

function buildParentOptions(
  parent: Pick<AuxiliaryParent, 'options' | 'permissionMode'>
): Record<string, string> {
  return {
    ...parent.options,
    ...(parent.permissionMode
      ? { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: parent.permissionMode }
      : {})
  }
}

async function prepareAuxiliary(
  params: z.infer<typeof CreateAuxiliaryParams>,
  ctx: RpcContext
): Promise<PreparedAuxiliary | StructuredCreateRefused> {
  const conflict = agentSessionFingerprintConflict(
    params.envelope,
    createAuxiliaryFingerprint({
      sessionId: params.envelope.sessionId,
      parentSessionId: params.parentSessionId,
      ...(params.firstMessage ? { firstMessage: params.firstMessage } : {})
    })
  )
  if (conflict) {
    return { refusal: conflict }
  }
  await ensureHostInstalled(ctx, 'omp')
  const host = requireHost(ctx, 'omp')
  const parent = host.deps.store.getRecord(params.parentSessionId)
  if (!parent) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'recordMissing'
    })
  }
  if (!AUXILIARY_CHAT_PROVIDERS.includes(parent.provider as 'omp')) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const source = await resolveOmpAuxiliarySource(host, parent)
  let derived: OmpAuxiliaryConversation
  try {
    derived = await deriveOmpAuxiliaryConversation({
      sourcePath: source.sourcePath,
      sourceNativeId: source.sourceNativeId,
      working: await ompAuxiliaryParentWorking(host, parent)
    })
  } catch (error) {
    if (error instanceof OmpAuxiliaryDerivationError) {
      throw auxiliaryDerivationRefusal(error)
    }
    throw error
  }
  // A parent clear/resume during derivation must not create a child from the old branch.
  const current = host.deps.store.getRecord(params.parentSessionId)
  const currentContext = current ? activeProviderContext(current) : null
  if (
    !current ||
    current.auxiliaryChat ||
    currentContext?.pendingClear ||
    currentContext?.head?.handle.nativeId !== source.sourceNativeId
  ) {
    await derived.discard().catch(() => undefined)
    return {
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'savedConversationMissing' },
        'The parent conversation changed while the auxiliary chat was being created.'
      )
    }
  }
  return {
    host,
    derived,
    workspaceCwd: source.workspaceCwd,
    attachParams: auxiliaryAttachParams({ params, parent, derived })
  }
}

/** Standard create receipt; the child stays unlisted and its provider context is never journaled. */
export async function handleStructuredAgentSessionCreateAuxiliary(
  params: z.infer<typeof CreateAuxiliaryParams>,
  ctx: RpcContext
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  requireAuxiliaryAudience(ctx)
  if (params.envelope.expectedRuntimeFence !== null) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        'The auxiliary create request is malformed.'
      )
    }
  }
  const prepared = await resolveUncommittedStructuredCreate(
    () => prepareAuxiliary(params, ctx),
    'omp'
  )
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  const { host, attachParams, derived, workspaceCwd } = prepared
  const childId = params.envelope.sessionId
  // A retry or ambiguous replay may return an existing record; only the file it names may remain.
  const discardUnlessStagedFileCommitted = async () => {
    const record = host.deps.store.getRecord(childId)
    if (record?.auxiliaryChat?.nativeFilePath === derived.filePath) {
      return
    }
    await derived.discard().catch(() => undefined)
  }
  try {
    const result = await host.create(callerFor(ctx), attachParams, {
      ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
      ...(isFloatingWorkspaceId(attachParams.location.workspaceId)
        ? { hostLaunchDirectory: workspaceCwd }
        : {})
    })
    await discardUnlessStagedFileCommitted()
    if (!result.ok) {
      return result
    }
    return projectReceiptDeviceAttach(result, ctx)
  } catch (error) {
    await discardUnlessStagedFileCommitted()
    throw error
  }
}
