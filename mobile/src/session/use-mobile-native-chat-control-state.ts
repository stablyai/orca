import { useEffect, useState } from 'react'
import { canStopNativeChatAgent } from '../../../src/shared/native-chat-action-availability'

const COMPOSER_LOCK_SETTLE_MS = 600

export type MobileNativeChatInputLockReason = 'disconnected' | 'waiting'

export function useMobileNativeChatControlState(args: {
  inputLockReason: MobileNativeChatInputLockReason | null
  agentStatusLive: boolean
  stopTargetWritable: boolean
  stopCommandAvailable: boolean
}): {
  lockReason: MobileNativeChatInputLockReason | null
  statusStale: boolean
  canStopAgent: boolean
} {
  const rawLockHeld = args.inputLockReason !== null
  const [lockHeld, setLockHeld] = useState(false)
  useEffect(() => {
    if (rawLockHeld === lockHeld) {
      return
    }
    const timer = setTimeout(() => setLockHeld(rawLockHeld), COMPOSER_LOCK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [lockHeld, rawLockHeld])

  return {
    lockReason: lockHeld ? (args.inputLockReason ?? 'waiting') : null,
    statusStale: !args.agentStatusLive,
    canStopAgent: canStopNativeChatAgent({
      targetWritable: args.stopTargetWritable,
      stopCommandAvailable: args.stopCommandAvailable
    })
  }
}
