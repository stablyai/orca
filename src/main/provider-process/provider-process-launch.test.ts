import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProviderChildEnv } from './provider-process-launch'

describe('resolveProviderChildEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // zsh honors exported ARGV0, so agent tool shells ran host commands as `orca-ide` (#49649).
  it('keeps the AppImage runtime out of Linux provider children', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const env = resolveProviderChildEnv(
      {
        env: {
          PATH: '/home/u/.config/orca/linux-orca-cli-shim:/tmp/.mount_orcaX/usr/bin:/usr/bin',
          ORCA_CLI_COMMAND: '/home/u/.config/orca/linux-orca-cli-shim/orca'
        }
      },
      {
        APPIMAGE: '/home/u/Orca.AppImage',
        APPDIR: '/tmp/.mount_orcaX',
        ARGV0: 'orca-ide',
        OWD: '/home/u',
        LD_LIBRARY_PATH: '/tmp/.mount_orcaX/usr/lib',
        PATH: '/usr/bin',
        HOME: '/home/u'
      }
    )

    expect(env).toEqual({
      PATH: '/home/u/.config/orca/linux-orca-cli-shim:/usr/bin',
      ORCA_CLI_COMMAND: '/home/u/.config/orca/linux-orca-cli-shim/orca',
      HOME: '/home/u'
    })
  })
})
