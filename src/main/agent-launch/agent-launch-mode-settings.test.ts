import { describe, expect, it } from 'vitest'
import { nativeChatPreferenceFor } from '../../shared/agent-launch/choices/structured-native-chat-launch-route'
import { readAgentLaunchModeSettings } from './agent-launch-mode-settings'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../runtime/rpc/methods/orchestration/structured-workers/orchestration-worker-start-mode'

const runtime = {
  requireStore: () => ({
    getSettings: () => ({
      nativeChatProviders: { claude: false },
      agentCopies: [{ id: 'claude.chatty', name: 'Chatty', agent: 'claude' as const, chat: true }]
    })
  })
}

describe("a launch of an agent copy reads the copy's own Chat | CLI choice", () => {
  it('from the copy named in either option map', () => {
    const plain = readAgentLaunchModeSettings(runtime, { agent: 'claude' })
    expect(nativeChatPreferenceFor(plain, 'claude')).toBe(false)
    for (const caller of [
      { agent: 'claude', sessionOptions: { agentCopy: 'claude.chatty' } },
      { agent: 'claude', chatOptions: { agentCopy: 'claude.chatty' } }
    ]) {
      expect(nativeChatPreferenceFor(readAgentLaunchModeSettings(runtime, caller), 'claude')).toBe(
        true
      )
    }
  })

  it('for worker-start --agent <copy id>, decided as its base agent', () => {
    const settings = readWorkerStartModeSettings(runtime, 'claude.chatty')
    expect(nativeChatPreferenceFor(settings, 'claude')).toBe(true)
    expect(nativeChatPreferenceFor(readWorkerStartModeSettings(runtime, 'claude'), 'claude')).toBe(
      false
    )
    const receipt = decideWorkerStartMode({ params: { agent: 'claude.chatty' }, settings })
    expect(receipt.preferred).toBe('structured')
  })
})
