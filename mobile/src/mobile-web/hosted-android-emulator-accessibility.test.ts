import { describe, expect, it, vi } from 'vitest'
import {
  parseHostedAndroidAccessibilityControls,
  parseHostedAndroidDisplaySize,
  tapHostedAndroidAccessibilityControl,
  tapHostedAndroidPoint
} from '../../scripts/hosted-android-emulator-accessibility.mjs'

const emulator = { adb: '/sdk/platform-tools/adb' }

describe('hosted Android emulator accessibility controls', () => {
  it('parses enabled labels, descriptions, entities, and bounds', () => {
    const controls = parseHostedAndroidAccessibilityControls(`
      <hierarchy>
        <node text="Pair &amp; continue" content-desc="" enabled="true"
          bounds="[10,20][110,220]" />
        <node text="" content-desc="Open source control" enabled="true"
          bounds="[20,30][220,330]" />
        <node text="Disabled" content-desc="" enabled="false"
          bounds="[0,0][10,10]" />
      </hierarchy>
    `)

    expect(controls).toEqual([
      {
        label: 'Pair & continue',
        enabled: true,
        bounds: { left: 10, top: 20, right: 110, bottom: 220 }
      },
      {
        label: 'Open source control',
        enabled: true,
        bounds: { left: 20, top: 30, right: 220, bottom: 330 }
      },
      {
        label: 'Disabled',
        enabled: false,
        bounds: { left: 0, top: 0, right: 10, bottom: 10 }
      }
    ])
  })

  it('prefers the override display size', () => {
    expect(
      parseHostedAndroidDisplaySize('Physical size: 1280x2856\nOverride size: 1000x2200')
    ).toEqual({ width: 1000, height: 2200 })
  })

  it('taps the center of an exact accessible label', async () => {
    const runAdb = vi
      .fn()
      .mockResolvedValueOnce(
        '<hierarchy><node text="Pair" enabled="true" bounds="[100,200][300,400]" /></hierarchy>'
      )
      .mockResolvedValueOnce('')

    await expect(
      tapHostedAndroidAccessibilityControl(emulator, 'Pair', 1_000, runAdb)
    ).resolves.toEqual({ x: 200, y: 300 })
    expect(runAdb).toHaveBeenLastCalledWith(emulator.adb, ['shell', 'input', 'tap', '200', '300'])
  })

  it('maps a normalized WebView point to physical display pixels', async () => {
    const runAdb = vi
      .fn()
      .mockResolvedValueOnce('Physical size: 1280x2856')
      .mockResolvedValueOnce('')

    await expect(tapHostedAndroidPoint(emulator, { x: 0.25, y: 0.5 }, runAdb)).resolves.toEqual({
      x: 320,
      y: 1428
    })
    expect(runAdb).toHaveBeenLastCalledWith(emulator.adb, ['shell', 'input', 'tap', '320', '1428'])
  })
})
