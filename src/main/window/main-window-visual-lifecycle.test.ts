import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('./macos-tahoe-release', () => ({ isMacosTahoeOrNewer: () => false }))

import { isMacAppPasteInput } from './main-window-visual-lifecycle'

function cmdKey(key: string, code: string, extra: Partial<Electron.Input> = {}): Electron.Input {
  return {
    type: 'keyDown',
    key,
    code,
    meta: true,
    control: false,
    alt: false,
    shift: false,
    ...extra
  } as Electron.Input
}

describe('isMacAppPasteInput', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['US Cmd+V', cmdKey('v', 'KeyV'), true],
    ['Turkish F Cmd+V (V lives on KeyC)', cmdKey('v', 'KeyC'), true],
    ['Turkish F Cmd+C (C lives on KeyV)', cmdKey('c', 'KeyV'), false],
    ['Cyrillic Cmd+V (non-Latin key on KeyV)', cmdKey('м', 'KeyV'), true],
    ['Cmd+Shift+V', cmdKey('V', 'KeyV', { shift: true }), false]
  ])('%s', (_name, input, expected) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(isMacAppPasteInput(input)).toBe(expected)
  })

  it('never claims paste off macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(isMacAppPasteInput(cmdKey('v', 'KeyV'))).toBe(false)
  })
})
