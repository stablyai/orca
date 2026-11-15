import { describe, expect, it } from 'vitest'
import { validateComputerProviderActionParams } from './computer-provider-action-validation'

function sendKey(
  method: 'hotkey' | 'pressKey',
  key: string,
  platform: NodeJS.Platform,
  allowSystemShortcut?: boolean
): Promise<string> {
  return validateComputerProviderActionParams(
    method,
    { app: 'Target', key, ...(allowSystemShortcut ? { allowSystemShortcut } : {}) },
    platform
  )
}

const BLOCKED: [NodeJS.Platform, 'hotkey' | 'pressKey', string][] = [
  ['linux', 'hotkey', 'Meta+F4'],
  ['linux', 'hotkey', 'Alt+70\rsuffix'],
  ['linux', 'pressKey', 'XF86_Switch_VT_2']
]

const ALLOWED: [NodeJS.Platform, 'hotkey' | 'pressKey', string][] = [
  ['linux', 'hotkey', 'Meta+L'],
  ['linux', 'hotkey', 'Ctrl+1']
]

describe('blocked system shortcuts', () => {
  it.each(BLOCKED)('refuses %s %s %s unless allowed', async (platform, method, key) => {
    await expect(sendKey(method, key, platform)).rejects.toMatchObject({
      code: 'system_shortcut_blocked'
    })
    await expect(sendKey(method, key, platform, true)).resolves.toBe('Target')
  })

  it.each(ALLOWED)('sends %s %s %s', async (platform, method, key) => {
    await expect(sendKey(method, key, platform)).resolves.toBe('Target')
  })
})
