import { useRef } from 'react'
import { seedNativeChatAppliedSessionOptionsIfUnseen } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-cache'
import type { SessionOptionValue } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'

// Synchronous during render so the option surface built later in the same render already sees the seed.
export function useMobileNativeChatAppliedSessionOptionSeed(args: {
  activeChatStructured: boolean
  agent: string | null
  scopeKey: string | null
  launchAgent?: string | null
  appliedSessionOptions?: Record<string, SessionOptionValue>
}): void {
  const { activeChatStructured, agent, scopeKey, launchAgent, appliedSessionOptions } = args
  const seededKey = useRef<string | null>(null)
  if (
    activeChatStructured ||
    !scopeKey ||
    !agent ||
    launchAgent !== agent ||
    !appliedSessionOptions
  ) {
    return
  }
  const key = JSON.stringify([scopeKey, agent, appliedSessionOptions])
  if (seededKey.current === key) {
    return
  }
  seededKey.current = key
  const values: Record<string, SessionOptionValue> = {}
  for (const [id, value] of Object.entries(appliedSessionOptions)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      values[id] = value
    }
  }
  seedNativeChatAppliedSessionOptionsIfUnseen(scopeKey, agent, values)
}
