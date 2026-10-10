import { describe, expect, it } from 'vitest'
import { getDiscordIpcSocketPaths } from './discord-ipc-socket-paths'

describe('getDiscordIpcSocketPaths', () => {
  it('probes the ten named pipes on Windows', () => {
    const paths = getDiscordIpcSocketPaths('win32', {})
    expect(paths).toHaveLength(10)
    expect(paths[0]).toBe('\\\\?\\pipe\\discord-ipc-0')
    expect(paths[9]).toBe('\\\\?\\pipe\\discord-ipc-9')
  })

  it('uses TMPDIR on macOS without sandbox subdirectories', () => {
    const paths = getDiscordIpcSocketPaths('darwin', { TMPDIR: '/var/folders/xy/T/' })
    expect(paths).toHaveLength(10)
    expect(paths[0]).toBe('/var/folders/xy/T/discord-ipc-0')
  })

  it('prefers XDG_RUNTIME_DIR on Linux and covers Flatpak and Snap installs', () => {
    const paths = getDiscordIpcSocketPaths('linux', {
      XDG_RUNTIME_DIR: '/run/user/1000',
      TMPDIR: '/tmp/ignored'
    })
    expect(paths[0]).toBe('/run/user/1000/discord-ipc-0')
    expect(paths).toContain('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0')
    expect(paths).toContain('/run/user/1000/snap.discord/discord-ipc-3')
    expect(paths.some((path) => path.startsWith('/tmp/ignored'))).toBe(false)
  })

  it('falls back to /tmp when no temp directory is configured', () => {
    expect(getDiscordIpcSocketPaths('linux', {})[0]).toBe('/tmp/discord-ipc-0')
  })
})
