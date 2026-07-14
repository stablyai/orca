import { describe, expect, it } from 'vitest'
import { resolveCodexSessionAuthorityHomes } from './codex-session-authority-homes'

describe('resolveCodexSessionAuthorityHomes', () => {
  it('keeps the runtime and system homes as separate authoritative namespaces', () => {
    expect(
      resolveCodexSessionAuthorityHomes({
        runtimeHomePath: '/orca/runtime/home',
        systemHomePath: '/home/ada/.codex',
        settings: {},
        platform: 'darwin'
      })
    ).toEqual(['/orca/runtime/home', '/home/ada/.codex'])
  })

  it('uses the configured host session home instead of the default system home', () => {
    expect(
      resolveCodexSessionAuthorityHomes({
        runtimeHomePath: '/orca/runtime/home',
        systemHomePath: '/home/ada/.codex',
        settings: { codexSessionSourceHome: { host: ' /mnt/history/codex ' } },
        platform: 'linux'
      })
    ).toEqual(['/orca/runtime/home', '/mnt/history/codex'])
  })

  it('maps configured WSL session homes to host-readable UNC authorities', () => {
    expect(
      resolveCodexSessionAuthorityHomes({
        runtimeHomePath: 'C:\\Users\\ada\\AppData\\Roaming\\orca\\codex-runtime-home\\home',
        systemHomePath: 'C:\\Users\\ada\\.codex',
        settings: {
          codexSessionSourceHome: {
            wsl: { Ubuntu: ' /home/ada/.config/codex ', Debian: 'relative/path' }
          }
        },
        platform: 'win32'
      })
    ).toEqual([
      'C:\\Users\\ada\\AppData\\Roaming\\orca\\codex-runtime-home\\home',
      'C:\\Users\\ada\\.codex',
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.config\\codex'
    ])
  })

  it('includes default WSL homes without mirroring their sessions', () => {
    expect(
      resolveCodexSessionAuthorityHomes({
        runtimeHomePath: 'C:\\Orca\\codex-runtime-home\\home',
        systemHomePath: 'C:\\Users\\ada\\.codex',
        settings: {},
        platform: 'win32',
        wslSystemHomes: new Map([['Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex']])
      })
    ).toContain('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex')
  })
})
