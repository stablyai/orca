import { describe, expect, it, vi } from 'vitest'
import { markPluginSavedFileAsDownloaded } from './plugin-save-as-download-mark'

function deps(platform: NodeJS.Platform) {
  return {
    platform,
    now: () => 0x10_000 * 1000,
    writeFile: vi.fn(async () => {}),
    runProcess: vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    }))
  }
}

describe('markPluginSavedFileAsDownloaded', () => {
  it('writes an Internet-zone Zone.Identifier stream on Windows', async () => {
    const d = deps('win32')
    await markPluginSavedFileAsDownloaded('C:\\out\\a.txt', d)
    expect(d.writeFile).toHaveBeenCalledWith(
      'C:\\out\\a.txt:Zone.Identifier',
      '[ZoneTransfer]\r\nZoneId=3\r\n'
    )
    expect(d.runProcess).not.toHaveBeenCalled()
  })

  it('sets com.apple.quarantine through xattr on macOS', async () => {
    const d = deps('darwin')
    await markPluginSavedFileAsDownloaded('/out/a.txt', d)
    expect(d.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/xattr',
        args: ['-w', 'com.apple.quarantine', '0083;10000;Orca;', '/out/a.txt']
      })
    )
  })

  it('does nothing on Linux and never fails the save', async () => {
    const linux = deps('linux')
    await markPluginSavedFileAsDownloaded('/out/a.txt', linux)
    expect(linux.writeFile).not.toHaveBeenCalled()
    expect(linux.runProcess).not.toHaveBeenCalled()
    const fat = deps('win32')
    fat.writeFile.mockRejectedValueOnce(new Error('no streams'))
    await expect(markPluginSavedFileAsDownloaded('E:\\a.txt', fat)).resolves.toBeUndefined()
  })
})
