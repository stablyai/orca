import {
  refuse,
  type AgentSessionAttachResult,
  type AgentSessionMutationResult,
  agentSessionSendSubmission
} from '../../../../shared/agent-session-wire'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/structured-agent-session-send-mutation'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { PreparedStructuredAgentSessionCreate } from './structured-agent-session-create'
import type { ChatTabPlacement } from '../../agent-session/agent-session-tab-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { structuredAgentSessionClosedBeforeCreate } from './structured-agent-session-close-before-create'

/** The commit half. Past `attach`, a failure no longer proves the session does not exist. */
export async function commitStructuredAgentSessionCreate(args: {
  runtime: OrcaRuntimeService
  caller: StructuredAgentSessionCaller
  prepared: PreparedStructuredAgentSessionCreate
  activate: boolean
  /** This machine's window made the create and opens the chat's tab where it reserved it. */
  placedByWindow?: boolean
  /** Where the creating client opens the chat, in this host's ids. */
  tabPlacement?: ChatTabPlacement
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { prepared } = args
  const tab = prepared.tab
  const tabPlace = {
    ...(args.placedByWindow ? { placedByWindow: true } : {}),
    ...(args.tabPlacement ? { placement: args.tabPlacement } : {})
  }
  if (prepared.atRest) {
    return prepared.host.create(args.caller, prepared.attachParams, {
      ...prepared.atRest,
      ...(prepared.catalogModels ? { catalogModels: prepared.catalogModels } : {}),
      ...(prepared.hostLaunchDirectory
        ? { hostLaunchDirectory: prepared.hostLaunchDirectory }
        : {}),
      ...(tab
        ? {
            // A chat closed while it was being made gets no tab to show before main closes it.
            publishTab: () =>
              ORCA_LAYOUT_OWNER_IS_MAIN &&
              structuredAgentSessionClosedBeforeCreate(prepared.attachParams.envelope.sessionId)
                ? Promise.resolve()
                : args.runtime.publishStructuredAgentSessionTab({
                    workspaceId: tab.workspaceId,
                    sessionId: prepared.attachParams.envelope.sessionId,
                    agent: tab.agent,
                    activate: args.activate,
                    ...tabPlace,
                    ...(prepared.attachParams.surfaceTabId
                      ? { tabId: prepared.attachParams.surfaceTabId }
                      : {})
                  })
          }
        : {})
    })
  }
  let result = await prepared.host.attach(args.caller, prepared.attachParams, {
    ...(prepared.hostLaunchDirectory ? { hostLaunchDirectory: prepared.hostLaunchDirectory } : {}),
    ...(prepared.catalogModels ? { catalogModels: prepared.catalogModels } : {})
  })
  if (!result.ok || !prepared.tab) {
    return result
  }
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    structuredAgentSessionClosedBeforeCreate(result.value.sessionId)
  ) {
    return result
  }
  if (prepared.firstMessage) {
    const first = prepared.firstMessage
    const sent = await prepared.host.send(
      args.caller,
      structuredAgentSessionMessageSendMutation({
        sessionId: result.value.sessionId,
        expectedRuntimeFence: result.value.fence,
        clientOperationId: first.clientMessageId,
        body: first.body
      })
    )
    const submission = sent.ok ? agentSessionSendSubmission(sent.value) : undefined
    if (!submission) {
      return {
        ok: false,
        refusal: refuse(
          'agent_session_operation_unknown',
          { reason: 'outcomeUnknown' },
          'The side chat opened, but its first message could not be confirmed.'
        )
      }
    }
    result = { ...result, value: { ...result.value, firstMessage: submission } }
  }
  // A chat closed while it was being made gets no tab to show before main closes it.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    structuredAgentSessionClosedBeforeCreate(result.value.sessionId)
  ) {
    return result
  }
  const surfaceTabId = prepared.attachParams.surfaceTabId
  try {
    await args.runtime.publishStructuredAgentSessionTab({
      workspaceId: prepared.tab.workspaceId,
      sessionId: result.value.sessionId,
      agent: prepared.tab.agent,
      activate: args.activate,
      ...tabPlace,
      ...(surfaceTabId ? { tabId: surfaceTabId } : {})
    })
  } catch (error) {
    prepared.host.deps.logger.warn('publishing the tab of a created chat failed', {
      scope: 'create-tab-publication',
      sessionId: result.value.sessionId,
      error
    })
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_unknown',
        { reason: 'tabUnconfirmed' },
        'The chat may have been created, but its tab could not be confirmed.'
      )
    }
  }
  // Read after publishing, which is what gives the chat its tab.
  const tabId = prepared.host.getSessionTabId?.(result.value.sessionId)
  return tabId ? { ...result, value: { ...result.value, tabId } } : result
}
