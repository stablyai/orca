import { describe, expect, it } from 'vitest'
import { bootAvdArgs, emuKillArgs, listAvdsArgs, parseAvdList } from './avd-manager'

describe('parseAvdList', () => {
  it('keeps AVD names while dropping blank and informational lines', () => {
    const stdout = ['Pixel_7', '', 'INFO | Storing crashdata in: /tmp/avd', 'Pixel_Tablet'].join(
      '\n'
    )
    expect(parseAvdList(stdout)).toEqual(['Pixel_7', 'Pixel_Tablet'])
  })

  it('returns an empty array for empty stdout', () => {
    expect(parseAvdList('')).toEqual([])
  })

  it('trims surrounding whitespace from kept names', () => {
    expect(parseAvdList('  Pixel_7  \r\n\tPixel_Tablet\t')).toEqual(['Pixel_7', 'Pixel_Tablet'])
  })

  it('drops WARNING, ERROR and "No AVD" lines', () => {
    const stdout = [
      'WARNING | no metrics',
      'Pixel_7',
      'ERROR | bad config',
      'No AVD found in /home/user/.android/avd'
    ].join('\n')
    expect(parseAvdList(stdout)).toEqual(['Pixel_7'])
  })
})

describe('listAvdsArgs', () => {
  it('is the emulator -list-avds invocation', () => {
    expect(listAvdsArgs).toEqual(['-list-avds'])
  })
})

describe('bootAvdArgs', () => {
  it('boots an AVD by name with no extra flags', () => {
    expect(bootAvdArgs('Pixel_7')).toEqual(['-avd', 'Pixel_7'])
  })

  it('appends the no-snapshot flag', () => {
    expect(bootAvdArgs('Pixel_7', { noSnapshot: true })).toEqual([
      '-avd',
      'Pixel_7',
      '-no-snapshot'
    ])
  })

  it('appends the no-window flag', () => {
    expect(bootAvdArgs('Pixel_7', { noWindow: true })).toEqual(['-avd', 'Pixel_7', '-no-window'])
  })

  it('appends the no-boot-anim flag', () => {
    expect(bootAvdArgs('Pixel_7', { noBootAnim: true })).toEqual([
      '-avd',
      'Pixel_7',
      '-no-boot-anim'
    ])
  })

  it('emits the gpu flag as two tokens', () => {
    expect(bootAvdArgs('Pixel_7', { gpu: 'swiftshader_indirect' })).toEqual([
      '-avd',
      'Pixel_7',
      '-gpu',
      'swiftshader_indirect'
    ])
  })

  it('orders the name first, then flags in the documented order', () => {
    expect(
      bootAvdArgs('Pixel_7', {
        noSnapshot: true,
        noWindow: true,
        noBootAnim: true,
        gpu: 'host'
      })
    ).toEqual(['-avd', 'Pixel_7', '-no-snapshot', '-no-window', '-no-boot-anim', '-gpu', 'host'])
  })
})

describe('emuKillArgs', () => {
  it('targets a serial with the adb emu kill command', () => {
    expect(emuKillArgs('emulator-5554')).toEqual(['-s', 'emulator-5554', 'emu', 'kill'])
  })
})
