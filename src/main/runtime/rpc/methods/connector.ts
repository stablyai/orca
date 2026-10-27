/** Gate every connector.* conversation handler on this host's experimentalConnectors setting, regardless of caller. */

import { delayUnlessAborted } from '../../../../shared/abort-aware-delay'
import { cloudConversation } from '../../../../shared/connector-cloud-contract'
import {
  ConnectorAnswer,
  ConnectorCancel,
  ConnectorPendingPrompt,
  ConnectorReply,
  ConnectorSend,
  ConnectorStart,
  ConnectorWatch
} from '../../../../shared/rpc-contract/connector-params'
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../../../external-conversations/external-conversation-events'
import {
  runtimeConversationHost,
  type ExternalConversationSeam
} from '../../../external-conversations/external-conversation-seam'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'
import { assertAgentLaunchTargetAuthorized } from './agent-launch-target-authorization'

export function requireSeam(
  runtime: Pick<OrcaRuntimeService, 'getExternalConversationSeam'>
): ExternalConversationSeam {
  const seam = runtime.getExternalConversationSeam()
  if (!seam) {
    throw new Error('connectors_disabled')
  }
  return seam
}

export const CONNECTOR_METHODS = [
  defineMethod({
    name: 'connector.start',
    permission: 'workspace',
    params: ConnectorStart,
    handler: async ({ source, externalId, deliveryId, ...input }, context) => {
      const seam = requireSeam(context.runtime)
      assertAgentLaunchTargetAuthorized(input.target, context)
      return seam.start(
        runtimeConversationHost(context.runtime),
        { source, externalId },
        deliveryId,
        input
      )
    }
  }),
  defineMethod({
    name: 'connector.send',
    permission: 'workspace',
    params: ConnectorSend,
    handler: async ({ source, externalId, deliveryId, text }, context) =>
      requireSeam(context.runtime).send(
        runtimeConversationHost(context.runtime),
        { source, externalId },
        deliveryId,
        text
      )
  }),
  defineMethod({
    name: 'connector.pendingPrompt',
    permission: 'workspace',
    params: ConnectorPendingPrompt,
    handler: async ({ source, externalId }, context) => ({
      prompt: requireSeam(context.runtime).pendingPrompt(runtimeConversationHost(context.runtime), {
        source,
        externalId
      })
    })
  }),
  defineMethod({
    name: 'connector.answer',
    permission: 'workspace',
    params: ConnectorAnswer,
    handler: async ({ source, externalId, promptId, optionId }, context) =>
      requireSeam(context.runtime).answer(
        runtimeConversationHost(context.runtime),
        { source, externalId },
        promptId,
        optionId
      )
  }),
  defineMethod({
    name: 'connector.cancel',
    permission: 'workspace',
    params: ConnectorCancel,
    handler: async ({ source, externalId, deliveryId }, context) =>
      requireSeam(context.runtime).cancel(
        runtimeConversationHost(context.runtime),
        { source, externalId },
        deliveryId
      )
  }),
  // `orca connector reply`: the calling pane names its cloud conversation and turn; Orca Cloud posts it.
  defineMethod({
    name: 'connector.reply',
    permission: 'workspace',
    params: ConnectorReply,
    handler: async ({ paneKey, replyId, text }, context) => {
      const target = requireSeam(context.runtime).replyTarget(paneKey)
      const conversation = target && cloudConversation(target.key)
      if (!target || !conversation) {
        throw new Error('not_a_cloud_conversation')
      }
      if (target.turnId === null) {
        throw new Error('no_current_turn')
      }
      const sent = await context.runtime
        .getConnectorCloud()
        ?.reply({ replyId, conversation, turnId: target.turnId, text })
      if (!sent) {
        throw new Error('connector_not_connected')
      }
      if (!sent.ok) {
        throw new Error(
          sent.error === 'not_this_hosts_thread' ? 'not_this_hosts_thread' : 'connector_unavailable'
        )
      }
      return sent.value
    }
  }),
  // Development only: the CLI has no stream transport, so a dev watch collects one window.
  defineMethod({
    name: 'connector.watch',
    permission: 'workspace',
    params: ConnectorWatch,
    handler: async ({ forMs }, context) => {
      const seam = requireSeam(context.runtime)
      let snapshot: ConversationSnapshot | null = null
      const events: ConversationEvent[] = []
      const release = seam.watch(runtimeConversationHost(context.runtime), (event) => {
        if (event.kind === 'snapshot') {
          snapshot = event
        } else {
          events.push(event)
        }
      })
      // A closed connection or a disable ends the window early.
      const ended = AbortSignal.any([seam.signal, ...(context.signal ? [context.signal] : [])])
      try {
        await delayUnlessAborted(forMs, ended)
      } finally {
        release()
      }
      return { snapshot, events }
    }
  })
]
