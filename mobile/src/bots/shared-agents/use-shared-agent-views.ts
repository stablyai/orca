// The agents shared with a paired computer's account, as this phone reaches them, kept current.
// Native screens read the phone's owner directly; a computer's pages ask their shell
// (use-shared-agent-views.web.ts).
import { useCallback, useEffect, useState } from 'react'
import type { SharedBotHostView } from '../../../../src/shared/bots/shared-bot-hosts'
import { phoneSharedAgents } from './phone-shared-agents'

/** Null until the phone's shared agents are read, or where nothing serves them. */
export function useSharedAgentViews(pairedHostId: string): readonly SharedBotHostView[] | null {
  const [views, setViews] = useState<{ hostId: string; views: SharedBotHostView[] } | null>(null)
  useEffect(() => {
    const stop = phoneSharedAgents().watch(pairedHostId, (next) =>
      setViews({ hostId: pairedHostId, views: next })
    )
    return () => stop()
  }, [pairedHostId])
  return views?.hostId === pairedHostId ? views.views : null
}

/** Holds a refused message again; false when it couldn't be. */
export function useSharedAgentSendAgain(
  pairedHostId: string
): (environmentId: string, clientMessageId: string) => Promise<boolean> {
  return useCallback(
    async (environmentId, clientMessageId) => {
      const agents = phoneSharedAgents()
      await agents.ready()
      const agent = agents.find(pairedHostId, environmentId)
      return agent ? await agents.sendAgain(agent, clientMessageId) : false
    },
    [pairedHostId]
  )
}
