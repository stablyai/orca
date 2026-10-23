/**
 * `connector.*`: the external-conversation seam (Slack and other threads) behind
 * `experimentalConnectors`. The host's setting is the only gate, so a call while it is off is
 * refused here whoever makes it.
 */

import { ConnectorSend, ConnectorStart } from '../../../../shared/rpc-contract/connector-params'
import {
  runtimeConversationHost,
  type ExternalConversationSeam
} from '../../../external-conversations/external-conversation-seam'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'
import { assertAgentLaunchTargetAuthorized } from './agent-launch-target-authorization'

/** Every `connector.*` handler's first step. */
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
  })
]
