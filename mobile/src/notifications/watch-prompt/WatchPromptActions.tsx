import { useEffect } from 'react'
import { useRpcClientContext } from '../../transport/connection/client-context'
import { answerWatchPrompt } from './watch-prompt-host'
import { forgetWatchPrompt, subscribeWatchPrompts } from './watch-prompt-action'

/** Drains Allow/Deny taps that arrived from Apple Watch, including ones stored across a relaunch. */
export function WatchPromptActions(): null {
  const ctx = useRpcClientContext()
  useEffect(() => {
    return subscribeWatchPrompts(async (pending) => {
      const outcome = await answerWatchPrompt(ctx, pending)
      if (outcome === 'accepted' || outcome === 'stale') {
        await forgetWatchPrompt(pending)
      }
    })
  }, [ctx])
  return null
}
