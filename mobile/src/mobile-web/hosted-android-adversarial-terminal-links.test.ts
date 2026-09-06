import { describe, expect, it, vi } from 'vitest'
import {
  dismissHostedAndroidKeyboardIfShown,
  hostedAndroidAdversarialTerminalInputText,
  verifyHostedAndroidAdversarialTerminalLinks
} from '../../scripts/hosted-android-adversarial-terminal-links.mjs'

describe('hosted Android adversarial terminal links', () => {
  it('stages links through the focused live terminal input', async () => {
    const activateTerminal = vi.fn().mockResolvedValue(undefined)
    const dismissKeyboard = vi.fn().mockResolvedValue(false)
    const runAdb = vi.fn().mockResolvedValue('')
    const stageWithInput = vi.fn(async (_args, inputCommand) => {
      await inputCommand('node ".git/orca-mobile-terminal-links.cjs"')
      return 'terminal-handle'
    })
    const tapControl = vi.fn().mockResolvedValue(undefined)
    const verifyLinks = vi.fn(async (_args, operations) => {
      return operations.writeLinks({ timeoutMs: 30_000 })
    })
    const args = {
      document: { targetId: 'android-webview' },
      emulator: { adb: '/sdk/platform-tools/adb' },
      timeoutMs: 30_000
    }

    await expect(
      verifyHostedAndroidAdversarialTerminalLinks(args, {
        activateTerminal,
        dismissKeyboard,
        runAdb,
        stageWithInput,
        tapControl,
        verifyLinks
      })
    ).resolves.toBe('terminal-handle')

    expect(activateTerminal).toHaveBeenCalledWith(args.document, {
      kind: 'text',
      value: 'Mobile Emulator'
    })
    expect(tapControl).toHaveBeenCalledWith(
      args.emulator,
      'Show keyboard for live terminal input',
      30_000
    )
    expect(runAdb).toHaveBeenNthCalledWith(1, args.emulator.adb, [
      'shell',
      'input',
      'text',
      'node%s.git/orca-mobile-terminal-links.cjs'
    ])
    expect(runAdb).toHaveBeenNthCalledWith(2, args.emulator.adb, [
      'shell',
      'input',
      'keyevent',
      'KEYCODE_ENTER'
    ])
    expect(runAdb).toHaveBeenCalledTimes(2)
    expect(dismissKeyboard).toHaveBeenCalledWith(args.emulator.adb, runAdb)
  })

  it('dismisses only an observed Android input method', async () => {
    const visibleRunAdb = vi
      .fn()
      .mockResolvedValueOnce(
        'InsetsSource id=20b40001 type=navigationBars frame=[0,2712][1280,2856] visible=true\nmImeShowing=true'
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('mImeShowing=false')
    await expect(
      dismissHostedAndroidKeyboardIfShown('/sdk/platform-tools/adb', visibleRunAdb)
    ).resolves.toBe(true)
    expect(visibleRunAdb).toHaveBeenNthCalledWith(2, '/sdk/platform-tools/adb', [
      'shell',
      'input',
      'tap',
      '128',
      '2784'
    ])

    const hiddenRunAdb = vi.fn().mockResolvedValue('mImeShowing=false')
    await expect(
      dismissHostedAndroidKeyboardIfShown('/sdk/platform-tools/adb', hiddenRunAdb)
    ).resolves.toBe(false)
    expect(hiddenRunAdb).toHaveBeenCalledOnce()
  })

  it('accepts only the generated disposable script command', () => {
    expect(
      hostedAndroidAdversarialTerminalInputText('node ".git/orca-mobile-terminal-links.cjs"')
    ).toBe('node%s.git/orca-mobile-terminal-links.cjs')
    expect(() => hostedAndroidAdversarialTerminalInputText('node other.cjs')).toThrow(
      'staging command is invalid'
    )
  })
})
