import { afterEach, describe, expect, it } from 'vitest'
import { delimiter } from 'node:path'
import { removeAppImageRuntimeEnv } from './appimage-terminal-env'

describe('removeAppImageRuntimeEnv', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('removes AppImage runtime identity and mount paths from Linux terminal env', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })

    const env = {
      APPIMAGE: '/data/apps/orca.appimage',
      APPDIR: '/tmp/.mount_orca123',
      ARGV0: '/data/apps/orca.appimage',
      OWD: '/home/user',
      APPIMAGE_LIBRARY_PATH: '/tmp/.mount_orca123/usr/lib',
      PATH: ['/tmp/.mount_orca123', '/tmp/.mount_orca123/usr/sbin', '/usr/bin'].join(delimiter),
      LD_LIBRARY_PATH: ['/tmp/.mount_orca123/usr/lib', '/opt/audio/lib'].join(delimiter),
      HOME: '/home/user'
    }

    removeAppImageRuntimeEnv(env)

    expect(env).toEqual({
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/audio/lib',
      HOME: '/home/user'
    })
  })

  it('leaves non-AppImage environments untouched', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const env = {
      PATH: ['/opt/tools', '/usr/bin'].join(delimiter),
      LD_LIBRARY_PATH: '/opt/audio/lib'
    }

    removeAppImageRuntimeEnv(env)

    expect(env).toEqual({
      PATH: ['/opt/tools', '/usr/bin'].join(delimiter),
      LD_LIBRARY_PATH: '/opt/audio/lib'
    })
  })

  it('removes AppImage ARGV0 even without a mounted APPDIR', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const env = {
      ARGV0: '/data/apps/orca.appimage',
      PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter)
    }

    removeAppImageRuntimeEnv(env)

    expect(env).toEqual({
      PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter)
    })
  })

  it('leaves AppImage-looking env untouched outside Linux', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const env = {
      APPIMAGE: '/data/apps/orca.appimage',
      APPDIR: '/tmp/.mount_orca123',
      ARGV0: '/data/apps/orca.appimage',
      PATH: ['/tmp/.mount_orca123/usr/bin', '/usr/bin'].join(delimiter)
    }

    removeAppImageRuntimeEnv(env)

    expect(env).toEqual({
      APPIMAGE: '/data/apps/orca.appimage',
      APPDIR: '/tmp/.mount_orca123',
      ARGV0: '/data/apps/orca.appimage',
      PATH: ['/tmp/.mount_orca123/usr/bin', '/usr/bin'].join(delimiter)
    })
  })
})
