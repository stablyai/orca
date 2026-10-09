import { describe, expect, it } from 'vitest'
import { IDENTITY, record, resolverFor } from './claude-structured-launch-resolution.test-fixture'
import { withAgentChatPermissionSeed } from '../native-chat/agent-chat-permission-mode-setting'
import { structuredAgentConfiguredArgs } from '../native-chat/structured-agent-configured-args'
describe('Claude saved launch permissions', () => {
  it.each(['', '--dangerously-skip-permissions', '--model Opus --dangerously-skip-permissions'])(
    'uses the saved creation mode regardless of terminal args %s',
    async (claude) => {
      for (const nativeChatPermissionMode of ['ask', 'bypass'] as const) {
        const saved = record({
          options: withAgentChatPermissionSeed('claude', { nativeChatPermissionMode }, undefined),
          launchArgs: structuredAgentConfiguredArgs('claude', { agentDefaultArgs: { claude } })
        })
        const launch = await resolverFor(saved, undefined, false)({ identity: IDENTITY })
        expect(launch.permissionMode).toBe(nativeChatPermissionMode)
        expect('dangerously-skip-permissions' in (launch.options.extraArgs ?? {})).toBe(
          nativeChatPermissionMode === 'bypass'
        )
        expect(launch.options.permissionMode).toBe(
          nativeChatPermissionMode === 'ask' ? 'default' : undefined
        )
      }
    }
  )

  // A resume uses only the chat's saved choice.
  it.each([
    ['bypass', true],
    ['ask', false],
    ['accept-edits', false],
    ['auto', false]
  ] as const)('launches a chat that chose %s in its saved mode', async (mode, bypassFlag) => {
    const launch = await resolverFor(
      record({ options: { permissionMode: mode } }),
      undefined,
      false
    )({ identity: IDENTITY })

    expect(launch.permissionMode).toBe(mode)
    expect('dangerously-skip-permissions' in (launch.options.extraArgs ?? {})).toBe(bypassFlag)
  })

  it('uses Ask for a legacy chat without a saved mode', async () => {
    const launch = await resolverFor(record(), undefined, false)({ identity: IDENTITY })

    expect(launch.permissionMode).toBe('ask')
  })

  it('passes configured arguments on start without taking over permission or session flags', async () => {
    const launch = await resolverFor(
      record({
        launchArgs: [
          '--model',
          'claude-sonnet-4-5',
          '--dangerously-skip-permissions',
          '--resume=wrong-session',
          '--permission-mode',
          'bypassPermissions'
        ]
      })
    )({ identity: IDENTITY })

    expect(launch.options.model).toBeUndefined()
    expect(launch.options.extraArgs).toEqual({
      model: 'claude-sonnet-4-5',
      'replay-user-messages': null
    })
    expect(launch.options.permissionMode).toBe('default')
    expect(launch.options.sessionId).toBe(launch.providerSessionId)
  })
})
