// A computer's page reads its shared agents from its shell, which reaches them over the phone's own
// links: a watch the shell answers on each change, and its verb to send a refused message again. An
// older shell grants no verb and serves no watch, so the page lists none.
import { useCallback, useEffect, useState } from 'react'
import type { SharedBotHostView } from '../../../../src/shared/bots/shared-bot-hosts'
import {
  BRIDGE_SHARED_AGENTS_VERB,
  SHARED_AGENTS_WATCH_METHOD,
  sharedAgentsResultSchema,
  sharedAgentsWatchEventSchema
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-shared-agents-verb'
import { usePageBridgeClientIfPresent } from '../../transport/connection/client-context.web'

export function useSharedAgentViews(_pairedHostId: string): readonly SharedBotHostView[] | null {
  const client = usePageBridgeClientIfPresent()
  const served =
    client?.getShellSession()?.grants.native.includes(BRIDGE_SHARED_AGENTS_VERB) === true
  const [views, setViews] = useState<SharedBotHostView[] | null>(null)
  useEffect(() => {
    if (!client || !served) {
      return
    }
    return client.subscribe(SHARED_AGENTS_WATCH_METHOD, {}, (data) => {
      const event = sharedAgentsWatchEventSchema.safeParse(data).data
      if (event) {
        setViews(event.hosts)
      }
    })
  }, [client, served])
  return served ? views : null
}

export function useSharedAgentSendAgain(
  _pairedHostId: string
): (environmentId: string, clientMessageId: string) => Promise<boolean> {
  const client = usePageBridgeClientIfPresent()
  return useCallback(
    async (environmentId, clientMessageId) => {
      if (!client) {
        return false
      }
      const reply = await client
        .callNativeVerb(BRIDGE_SHARED_AGENTS_VERB, {
          action: 'sendAgain',
          environmentId,
          clientMessageId
        })
        .catch(() => null)
      return sharedAgentsResultSchema.safeParse(reply?.result).data?.sent === true
    },
    [client]
  )
}
