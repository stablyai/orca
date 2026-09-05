import { describe, expect, it } from 'vitest'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

const electronBinary = '/tmp/electron'
const electronArgs = ['/tmp/main.cjs', '--user-data-dir=/tmp/profile']

describe('electron probe launch resolution', () => {
  it('reuses an inherited X display instead of nesting another xvfb-run server', () => {
    expect(
      resolveElectronProbeLaunch({
        electronBinary,
        electronArgs,
        platform: 'linux',
        display: ':99'
      })
    ).toEqual({
      executable: electronBinary,
      args: ['/tmp/main.cjs', '--user-data-dir=/tmp/profile', '--no-sandbox']
    })
  })

  it('owns a display when Linux hands the probe none', () => {
    expect(
      resolveElectronProbeLaunch({
        electronBinary,
        electronArgs,
        platform: 'linux',
        display: undefined
      })
    ).toEqual({
      executable: 'xvfb-run',
      args: [
        '--auto-servernum',
        electronBinary,
        '/tmp/main.cjs',
        '--user-data-dir=/tmp/profile',
        '--no-sandbox'
      ]
    })
  })

  it('treats an empty DISPLAY as no display', () => {
    expect(
      resolveElectronProbeLaunch({ electronBinary, electronArgs, platform: 'linux', display: '' })
        .executable
    ).toBe('xvfb-run')
  })

  it('leaves non-Linux launches on the plain Electron binary', () => {
    expect(
      resolveElectronProbeLaunch({
        electronBinary,
        electronArgs,
        platform: 'darwin',
        display: undefined
      })
    ).toEqual({ executable: electronBinary, args: electronArgs })
  })
})
