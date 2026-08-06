import { describe, expect, it } from 'vitest'
import {
  resolveHostCodexSessionSourceHome,
  resolveWslCodexSessionSourceHome
} from './codex-session-source-home'

describe('resolveHostCodexSessionSourceHome', () => {
  it('returns undefined when no override is configured', () => {
    expect(resolveHostCodexSessionSourceHome({})).toBeUndefined()
    expect(resolveHostCodexSessionSourceHome({ codexSessionSourceHome: {} })).toBeUndefined()
  })

  it('returns undefined for blank/whitespace overrides so the default is kept', () => {
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: '   ' } })
    ).toBeUndefined()
  })

  it('returns the trimmed host override path', () => {
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: '  /custom/codex  ' } })
    ).toBe('/custom/codex')
  })
})

describe('resolveWslCodexSessionSourceHome', () => {
  it('returns undefined when no per-distro override exists', () => {
    expect(resolveWslCodexSessionSourceHome({}, 'Ubuntu')).toBeUndefined()
    expect(
      resolveWslCodexSessionSourceHome(
        { codexSessionSourceHome: { wsl: { Debian: '/home/me/.codex' } } },
        'Ubuntu'
      )
    ).toBeUndefined()
  })

  it('resolves a per-distro override for the matching distro', () => {
    expect(
      resolveWslCodexSessionSourceHome(
        { codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.config/codex' } } },
        'Ubuntu'
      )
    ).toBe('/home/me/.config/codex')
  })

  it('matches distro names case-insensitively, mirroring WSL', () => {
    expect(
      resolveWslCodexSessionSourceHome(
        { codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.config/codex' } } },
        'ubuntu'
      )
    ).toBe('/home/me/.config/codex')
  })

  it('ignores blank per-distro overrides so the default is kept', () => {
    expect(
      resolveWslCodexSessionSourceHome(
        { codexSessionSourceHome: { wsl: { Ubuntu: '  ' } } },
        'Ubuntu'
      )
    ).toBeUndefined()
  })

  it('does not leak the host override into WSL resolution', () => {
    expect(
      resolveWslCodexSessionSourceHome(
        { codexSessionSourceHome: { host: '/custom/codex' } },
        'Ubuntu'
      )
    ).toBeUndefined()
  })
})
