import { homedir } from 'node:os'
import { basename, join, parse, sep } from 'node:path'
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

  // The field's placeholder is `~/.codex`, so `~` is what users type; nothing
  // downstream expands it, and an unexpanded path finds no sessions.
  it('expands a leading ~ against the host home', () => {
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: '~/.codex-chatgpt' } })
    ).toBe(join(homedir(), '.codex-chatgpt'))
  })

  // The session backfill writes through this value, so broad filesystem
  // boundaries must never become implicit `sessions` targets.
  it('ignores values resolving to the home directory or filesystem root', () => {
    for (const host of [
      '~',
      '~/',
      '~/.',
      `~/../${basename(homedir())}`,
      // No tilde, so expandHostHomePrefix returns it verbatim and only the
      // safety check's resolve() can fold it back to the home dir.
      `${homedir()}/../${basename(homedir())}`,
      homedir(),
      parse(homedir()).root
    ]) {
      expect(
        resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host } })
      ).toBeUndefined()
    }
  })

  // On win32 a rooted-but-driveless value resolves against the CURRENT DRIVE,
  // so it is no better anchored than a relative one.
  it('rejects a win32 driveless-rooted value but keeps drive and UNC roots', () => {
    const driveless = resolveHostCodexSessionSourceHome({
      codexSessionSourceHome: { host: '\\codex' }
    })
    expect(driveless).toBeUndefined()
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: '\\\\server' } })
    ).toBeUndefined()
    expect(
      resolveHostCodexSessionSourceHome({
        codexSessionSourceHome: { host: 'C:\\Users\\me\\.codex' }
      })
    ).toBe(sep === '\\' ? 'C:\\Users\\me\\.codex' : undefined)
    expect(
      resolveHostCodexSessionSourceHome({
        codexSessionSourceHome: { host: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex' }
      })
    ).toBe(sep === '\\' ? '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex' : undefined)
  })

  it('leaves a ~ that is not a home prefix alone', () => {
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: '/codex/~backup' } })
    ).toBe('/codex/~backup')
  })

  // `\` is a legal filename character on POSIX, so only a backslash-separated
  // platform may read `~\` as a home prefix.
  it('expands a ~\\ prefix only where the backslash separates paths', () => {
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: '~\\.codex-chatgpt' } })
    ).toBe(sep === '\\' ? join(homedir(), '.codex-chatgpt') : undefined)
  })

  // A relative value is never a real Codex home, and the session backfill uses
  // this path as a WRITE target — resolving it against cwd would mkdir a stray tree.
  it('ignores a value that is still relative after expansion', () => {
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: '~codex' } })
    ).toBeUndefined()
    expect(
      resolveHostCodexSessionSourceHome({ codexSessionSourceHome: { host: 'my-codex-home' } })
    ).toBeUndefined()
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
