// The owner's Slack thread switch and post actions for a bot's chat, from Orca or a phone; an agent's
// CLI never changes who sees the owner's words.
import {
  ConnectorSlackMirrorPost,
  ConnectorSlackMirrorSet,
  ConnectorSlackMirrorStatus
} from '../../../../../shared/rpc-contract/connectors/connector-params'
import { defineMethod } from '../../core'
import { ownerOnly } from '../bots-caller-gates'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { SlackMirror } from '../../../../external-conversations/slack-mirror'

const REFUSAL = 'Only the owner can change what posts to Slack'

function requireMirror(runtime: Pick<OrcaRuntimeService, 'getSlackMirror'>): SlackMirror {
  const mirror = runtime.getSlackMirror()
  if (!mirror) {
    throw new Error('connectors_disabled')
  }
  return mirror
}

export const CONNECTOR_SLACK_MIRROR_METHODS = [
  defineMethod({
    name: 'connector.slackMirror.set',
    permission: 'workspace',
    params: ConnectorSlackMirrorSet,
    handler: (params, context) => {
      ownerOnly(context, REFUSAL)
      return { ok: requireMirror(context.runtime).setMirror(params.sessionId, params.on) }
    }
  }),
  defineMethod({
    name: 'connector.slackMirror.post',
    permission: 'workspace',
    params: ConnectorSlackMirrorPost,
    handler: async (params, context) => {
      ownerOnly(context, REFUSAL)
      const mirror = requireMirror(context.runtime)
      const { sessionId, itemId } = params
      const ok =
        params.action === 'retry'
          ? await mirror.retry(sessionId, itemId)
          : params.action === 'dismiss'
            ? mirror.dismiss(sessionId, itemId)
            : await mirror.deleteFromSlack(sessionId, itemId)
      return { ok }
    }
  }),
  defineMethod({
    name: 'connector.slackMirror.status',
    permission: 'workspace',
    params: ConnectorSlackMirrorStatus,
    handler: async (params, context) => {
      ownerOnly(context, REFUSAL)
      return { status: await requireMirror(context.runtime).status(params.sessionId) }
    }
  })
]
