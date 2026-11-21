import { defineMethod } from '../../../core'
import { LiveTextShownParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-subscribe-params'
import {
  liveTextViewerKey,
  setLiveTextViewerShown
} from './structured-agent-session-live-text-viewers'

/** A live-text viewer says it is shown or hidden; its streams of the chat follow, whichever
 *  connection carries them (a remote desktop's streams ride their own sockets). */
export const STRUCTURED_AGENT_SESSION_LIVE_TEXT_SHOWN_METHOD = defineMethod({
  name: 'agentSession.liveTextShown',
  permission: 'workspace',
  params: LiveTextShownParams,
  handler: (params) => {
    setLiveTextViewerShown(liveTextViewerKey(params.sessionId, params.viewerId), params.shown)
    return { ok: true as const }
  }
})
