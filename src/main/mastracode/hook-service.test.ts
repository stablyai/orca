import { describe, expect, it } from 'vitest'
import type { HooksConfig } from '../agent-hooks/installer-utils'
import { applyManagedMastraCodeHooks, MASTRACODE_HOOK_EVENTS } from './hook-service'

describe('Mastra Code managed hooks', () => {
  it('adds every status event while preserving user hooks', () => {
    const userHook = { type: 'command', command: 'node user-hook.js' }
    const config: HooksConfig = { UserPromptSubmit: [userHook], customSetting: true }

    applyManagedMastraCodeHooks(
      config,
      "'/Users/test/.orca/agent-hooks/mastracode-hook.sh'",
      'mastracode-hook.sh'
    )

    expect(config.customSetting).toBe(true)
    expect(config.UserPromptSubmit).toContainEqual(userHook)
    for (const eventName of MASTRACODE_HOOK_EVENTS) {
      expect(config[eventName]).toContainEqual(
        expect.objectContaining({
          type: 'command',
          command: "'/Users/test/.orca/agent-hooks/mastracode-hook.sh'",
          timeout: 10_000
        })
      )
    }
  })

  it('moves stale managed entries to the current event set', () => {
    const staleHook = {
      type: 'command',
      command: "'/Users/test/.orca/agent-hooks/mastracode-hook.sh'"
    }
    const config: HooksConfig = { LegacyEvent: [staleHook] }

    applyManagedMastraCodeHooks(
      config,
      "'/Users/test/.orca/agent-hooks/mastracode-hook.sh'",
      'mastracode-hook.sh'
    )

    expect(config).not.toHaveProperty('LegacyEvent')
  })
})
