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
  ['darwin', 'hotkey', 'Cmd+Q'],
  ['darwin', 'hotkey', 'CmdOrCtrl+q'],
  ['darwin', 'hotkey', 'Shift+Command+Q'],
  ['darwin', 'hotkey', 'Cmd+Option+Shift+Q'],
  ['darwin', 'hotkey', 'Ctrl+Meta+Q'],
  ['darwin', 'hotkey', 'Cmd+Alt+Esc'],
  ['darwin', 'hotkey', 'Cmd+Shift+Delete'],
  ['win32', 'hotkey', 'Alt+F4'],
  ['win32', 'hotkey', 'Win+L'],
  ['win32', 'hotkey', 'Ctrl+Shift+Escape'],
  ['linux', 'hotkey', 'Ctrl+Q'],
  ['linux', 'hotkey', 'CmdOrCtrl+Shift+Q'],
  ['linux', 'hotkey', 'Alt+F4'],
  ['linux', 'hotkey', 'Super+L'],
  ['linux', 'hotkey', 'ctrl+alt+Delete'],
  ['linux', 'hotkey', 'ctrl+alt+BackSpace'],
  ['linux', 'hotkey', 'Ctrl+Alt+F2'],
  ['linux', 'hotkey', 'Meta+F4'],
  ['linux', 'hotkey', 'Ctrl+0x71'],
  ['linux', 'hotkey', 'Alt+0xffc1'],
  ['linux', 'hotkey', 'Alt+70'],
  ['linux', 'hotkey', 'Alt+70suffix'],
  ['linux', 'hotkey', 'Alt+70\rsuffix'],
  ['linux', 'hotkey', 'Ctrl+Alt+L1'],
  ['linux', 'hotkey', 'Ctrl+XF86Switch_VT_1'],
  ['linux', 'pressKey', 'XF86_Switch_VT_2'],
  ['linux', 'pressKey', 'Terminate_Server'],
  ['linux', 'pressKey', 'XF86PowerOff'],
  ['linux', 'pressKey', 'XF86_Sleep'],
  ['linux', 'pressKey', 'ScreenSaver'],
  ['linux', 'pressKey', '0x1008FF2A']
]

const ALLOWED: [NodeJS.Platform, 'hotkey' | 'pressKey', string][] = [
  ['darwin', 'hotkey', 'Cmd+A'],
  ['darwin', 'hotkey', 'Ctrl+Q'],
  ['darwin', 'hotkey', 'Cmd+ForwardDelete'],
  ['darwin', 'pressKey', 'q'],
  ['win32', 'hotkey', 'Ctrl+Q'],
  ['win32', 'hotkey', 'Ctrl+Alt+Delete'],
  ['linux', 'hotkey', 'Cmd+Q'],
  ['linux', 'hotkey', 'Ctrl+Delete'],
  ['linux', 'hotkey', 'Meta+L'],
  ['linux', 'hotkey', 'Ctrl+u'],
  ['linux', 'hotkey', 'Ctrl+1'],
  ['linux', 'pressKey', 'Escape']
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
