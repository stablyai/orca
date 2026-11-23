import { useRef } from 'react'
import { seedNativeChatLaunchSessionOptionsIfUnseen } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-cache'
import type { SessionOptionValue } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'

// Synchronous during render so the option surface built later in the same render already sees the seed.
export function useMobileNativeChatLaunchSessionOptionSeed(args: {
  activeChatStructured: boolean
  agent: string | null
  scopeKey: string | null
  launchAgent?: string | null
  launchSessionOptions?: Record<string, SessionOptionValue>
}): void {
  const { activeChatStructured, agent, scopeKey, launchAgent, launchSessionOptions } = args
  const seededKey = useRef<string | null>(null)
  if (
    activeChatStructured ||
    !scopeKey ||
    !agent ||
    launchAgent !== agent ||
    !launchSessionOptions
  ) {
    return
  }
  const key = JSON.stringify([scopeKey, agent, launchSessionOptions])
  if (seededKey.current === key) {
    return
  }
  seededKey.current = key
  const values: Record<string, SessionOptionValue> = {}
  for (const [id, value] of Object.entries(launchSessionOptions)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      values[id] = value
    }
  }
  seedNativeChatLaunchSessionOptionsIfUnseen(scopeKey, agent, values)
}
