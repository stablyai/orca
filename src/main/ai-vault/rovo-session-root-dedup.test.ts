import { describe, expect, it } from 'vitest'
import { dedupeRovoLegacySessionCopies } from './rovo-session-root-dedup'

type Candidate = { agent: string; file: { path: string } }

function rovo(path: string): Candidate {
  return { agent: 'rovo', file: { path } }
}

describe('dedupeRovoLegacySessionCopies', () => {
  it('keeps the ~/.rovo copy when a session also exists in ~/.rovodev', () => {
    const current = rovo('/Users/ada/.rovo/sessions/abc/metadata.json')
    const legacy = rovo('/Users/ada/.rovodev/sessions/abc/metadata.json')

    expect(dedupeRovoLegacySessionCopies([legacy, current])).toEqual([current])
  })

  it('keeps legacy-only sessions', () => {
    const current = rovo('/Users/ada/.rovo/sessions/abc/metadata.json')
    const legacyOnly = rovo('/Users/ada/.rovodev/sessions/old/metadata.json')

    expect(dedupeRovoLegacySessionCopies([current, legacyOnly])).toEqual([current, legacyOnly])
  })

  it('does not dedupe across execution hosts', () => {
    const native = rovo('/Users/ada/.rovo/sessions/abc/metadata.json')
    const wslLegacy = rovo(
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.rovodev\\sessions\\abc\\metadata.json'
    )

    expect(dedupeRovoLegacySessionCopies([native, wslLegacy])).toEqual([native, wslLegacy])
  })

  it('dedupes Windows-style paths within the same WSL distro', () => {
    const current = rovo(
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.rovo\\sessions\\abc\\metadata.json'
    )
    const legacy = rovo('\\\\wsl$\\ubuntu\\home\\ada\\.rovodev\\sessions\\abc\\metadata.json')

    expect(dedupeRovoLegacySessionCopies([current, legacy])).toEqual([current])
  })

  it('leaves other agents untouched', () => {
    const other = {
      agent: 'codex',
      file: { path: '/Users/ada/.rovodev/sessions/abc/metadata.json' }
    }
    const current = rovo('/Users/ada/.rovo/sessions/abc/metadata.json')

    expect(dedupeRovoLegacySessionCopies([other, current])).toEqual([other, current])
  })

  it('only treats the .rovodev/sessions root as legacy', () => {
    const current = rovo('/Users/ada/.rovo/sessions/abc/metadata.json')
    const notLegacy = rovo('/mnt/.rovodev/custom/abc/metadata.json')

    expect(dedupeRovoLegacySessionCopies([current, notLegacy])).toEqual([current, notLegacy])
  })
})
