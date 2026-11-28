import { defineMethod } from '../../../core'
import { LiveTextShownParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-subscribe-params'
import {
  liveTextViewerKey,
  setLiveTextViewerShown
} from './structured-agent-session-live-text-viewers'
import { SHARE_BY_SESSION } from '../../../../../../shared/bots/bot-share-rpc-methods'

/** A live-text viewer says it is shown or hidden; its streams of the chat follow, whichever
 *  connection carries them (a remote desktop's streams ride their own sockets). */
export const STRUCTURED_AGENT_SESSION_LIVE_TEXT_SHOWN_METHOD = defineMethod({
  name: 'agentSession.liveTextShown',
  permission: 'workspace',
  share: SHARE_BY_SESSION,
  params: LiveTextShownParams,
  handler: (params) => {
    setLiveTextViewerShown(
      liveTextViewerKey(params.sessionId, params.viewerId),
      params.shown,
      params.seq
    )
    return { ok: true as const }
  }
})
