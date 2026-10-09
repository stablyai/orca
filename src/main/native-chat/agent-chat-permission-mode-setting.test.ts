import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { agentChatPermissionModeForSettings } from './agent-chat-permission-mode-setting'

describe('host chat permission setting', () => {
  it.each(['claude', 'codex'] as const)(
    'ignores terminal arguments for %s after the seed',
    (agent) => {
      for (const nativeChatPermissionMode of ['ask', 'bypass', 'auto'] as const) {
        for (const args of [
          '',
          '--dangerously-skip-permissions',
          '--dangerously-bypass-approvals-and-sandbox'
        ]) {
          const settings: Partial<GlobalSettings> = {
            nativeChatPermissionMode,
            agentDefaultArgs: { claude: args, codex: args }
          }
          expect(agentChatPermissionModeForSettings(agent, settings)).toBe(nativeChatPermissionMode)
        }
      }
    }
  )
  it('uses a stricter fallback and never infers a missing host setting', () => {
    expect(
      agentChatPermissionModeForSettings('codex', { nativeChatPermissionMode: 'accept-edits' })
    ).toBe('ask')
    expect(
      agentChatPermissionModeForSettings('claude', { nativeChatPermissionMode: 'accept-edits' })
    ).toBe('accept-edits')
    expect(agentChatPermissionModeForSettings('claude', {})).toBe('ask')
    expect(agentChatPermissionModeForSettings('codex', null)).toBe('ask')
  })
})
