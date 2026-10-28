import { describe, expect, it } from 'vitest'
import { ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../../../shared/orcad-runtime-capabilities'
import {
  preflightWslMovePaths,
  wslMoveHostReadiness,
  type WslMovePathFacts,
  type WslMovePreflightProbes
} from './wsl-move-preflight'

const unc = (linux: string, distro = 'Ubuntu') =>
  `\\\\wsl.localhost\\${distro}${linux.replaceAll('/', '\\')}`

const facts = (root: string, head = 'abc'): WslMovePathFacts => ({
  gitCommonDir: `${root}/.git`,
  head,
  worktrees: [root, `${root}-feature`],
  marker: 'nonce-1'
})

// Both probes describe the same repo using their native path spellings.
function probes(
  host: Partial<Record<string, WslMovePathFacts | null>> = {}
): WslMovePreflightProbes {
  const linuxFacts = facts('/home/dev/app')
  return {
    desktop: async (path) =>
      path === unc('/home/dev/app')
        ? {
            gitCommonDir: unc('/home/dev/app/.git'),
            head: 'abc',
            worktrees: [unc('/home/dev/app'), unc('/home/dev/app-feature')],
            marker: 'nonce-1'
          }
        : null,
    host: async (path) =>
      path in host ? (host[path] ?? null) : path === '/home/dev/app' ? linuxFacts : null
  }
}

describe('preflightWslMovePaths', () => {
  it('passes a path that is the same repository on both sides', async () => {
    await expect(
      preflightWslMovePaths([unc('/home/dev/app')], 'Ubuntu', probes())
    ).resolves.toEqual({ refused: [] })
  })

  it.each([
    ['missing on the host', { '/home/dev/app': null }, 'missing-on-host'],
    ['a different HEAD', { '/home/dev/app': facts('/home/dev/app', 'other') }, 'different-object'],
    ['another repository', { '/home/dev/app': facts('/srv/elsewhere') }, 'different-object']
  ] as const)('refuses a path %s', async (_label, host, reason) => {
    await expect(
      preflightWslMovePaths([unc('/home/dev/app')], 'Ubuntu', probes(host))
    ).resolves.toEqual({ refused: [{ path: unc('/home/dev/app'), reason }] })
  })

  it('refuses drive mounts, other distros and paths the desktop cannot read', async () => {
    const result = await preflightWslMovePaths(
      [unc('/mnt/c/src'), unc('/home/dev/app', 'Debian'), unc('/home/dev/gone')],
      'Ubuntu',
      probes()
    )
    expect(result.refused.map((entry) => entry.reason)).toEqual([
      'windows-drive',
      'not-in-distro',
      'unreadable-on-desktop'
    ])
  })
})

describe('preflightWslMovePaths outside git', () => {
  const folder = (marker: string | null): WslMovePathFacts => ({
    gitCommonDir: null,
    head: null,
    worktrees: [],
    marker
  })
  const run = (desktopMarker: string | null, hostMarker: string | null) =>
    preflightWslMovePaths([unc('/srv/notes')], 'Ubuntu', {
      desktop: async () => folder(desktopMarker),
      host: async () => folder(hostMarker)
    })

  it('accepts a folder only when the host reads back the marker the desktop wrote', async () => {
    await expect(run('nonce-1', 'nonce-1')).resolves.toEqual({ refused: [] })
  })

  it.each([
    [null, null, 'identity-unproven'],
    ['nonce-1', null, 'identity-unproven'],
    ['nonce-1', 'nonce-2', 'different-object']
  ] as const)('refuses desktop marker %s / host marker %s', async (desktop, host, reason) => {
    await expect(run(desktop, host)).resolves.toEqual({
      refused: [{ path: unc('/srv/notes'), reason }]
    })
  })
})

describe('wslMoveHostReadiness', () => {
  it('asks for a host update until the host parses WSL moves', () => {
    expect(wslMoveHostReadiness([])).toBe('update-host')
    expect(wslMoveHostReadiness([ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY])).toBe(
      'ready'
    )
  })
})
