import { describe, expect, it, vi } from 'vitest'

const { execCommandMock } = vi.hoisted(() => ({ execCommandMock: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: execCommandMock }))

import type { SshConnection } from './ssh-connection'
import { BUNDLED_RIPGREP_PLATFORMS } from '../../shared/bundled-ripgrep'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import { gcRemoteRipgrepCache } from './ssh-relay-ripgrep-cache-gc'

const LINUX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')
const CURRENT = 'c0ffee0123456789-linux-x64'
const SUPERSEDED = 'dead000000000000-linux-x64'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the GC only issues exec commands; nothing else on the connection is reached.
const conn = {} as unknown as SshConnection

function scripts(): string[] {
  return execCommandMock.mock.calls.map(([, command]) => String(command))
}

// Why exclude `find`: the entry listing carries its own `rm -rf` sweep for stale tombstones, and
// counting that as a collection would make every assertion here pass for the wrong reason.
function removedTrees(): string[] {
  return scripts().filter(
    (s) => s.includes('rm -rf') && s.includes('.rg-gc-') && !s.includes('find ')
  )
}

function reply(entries: readonly string[], refs: readonly string[] | 'unreadable'): void {
  execCommandMock.mockReset()
  execCommandMock.mockImplementation((_conn: unknown, command: string) => {
    const text = String(command)
    if (text.includes('ENTRY %s')) {
      return Promise.resolve(
        `${entries.map((e) => `ENTRY ${e}`).join('\n')}\n__ORCA_RG_CACHE__LIST_OK`
      )
    }
    if (text.includes('REF %s')) {
      return Promise.resolve(
        refs === 'unreadable'
          ? '__ORCA_RG_CACHE__REFS_ERR'
          : `${refs.map((r) => `REF ${r}`).join('\n')}\n__ORCA_RG_CACHE__REFS_OK`
      )
    }
    if (text.includes('MOVED')) {
      return Promise.resolve('MOVED')
    }
    return Promise.resolve('')
  })
}

describe('remote ripgrep cache GC', () => {
  it('collects a build no relay installation references', async () => {
    reply([CURRENT, SUPERSEDED], [CURRENT])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toHaveLength(1)
    expect(removedTrees()[0]).toContain(SUPERSEDED)
  })

  it.each([LINUX, WINDOWS])(
    'rejects an empty reference on %j before any mutation',
    async (host) => {
      execCommandMock.mockReset()
      execCommandMock
        .mockResolvedValueOnce(`ENTRY ${SUPERSEDED}\r\n__ORCA_RG_CACHE__LIST_OK`)
        .mockResolvedValueOnce('REF \t\r\n__ORCA_RG_CACHE__REFS_OK')
      await gcRemoteRipgrepCache(conn, host, '/home/me')
      expect(execCommandMock).toHaveBeenCalledTimes(2)
    }
  )

  // Why: the reference is the whole safety argument. A build a live relay was launched against
  // must survive, however old its directory is.
  it('keeps a referenced build', async () => {
    reply([CURRENT, SUPERSEDED], [CURRENT, SUPERSEDED])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why this case exists: the relay directory is named from a hash of the relay bytes, and
  // ripgrep is not among them, so a release that bumps only the ripgrep package -- the monthly
  // Dependabot PR -- shares a relay directory with its predecessor while minting a new entry.
  // With a single marker slot the second client overwrote the first's reference and this pass
  // then collected the binary the first client's relay was still running against.
  it('keeps both builds when two clients share one relay directory', async () => {
    reply([CURRENT, SUPERSEDED], [CURRENT, SUPERSEDED])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why assert the shell and not just the parse: the marker is per entry, so a scan that read a
  // single fixed filename would silently see only one of the two references above.
  it('scans every marker in a relay directory, not one fixed name', async () => {
    execCommandMock.mockReset()
    execCommandMock.mockResolvedValue('__ORCA_RG_CACHE__LIST_OK')

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', {})
    execCommandMock.mockReset()
    execCommandMock.mockImplementation((_c: unknown, command: string) => {
      const text = String(command)
      if (text.includes('ENTRY %s')) {
        return Promise.resolve(`ENTRY ${SUPERSEDED}\n__ORCA_RG_CACHE__LIST_OK`)
      }
      return Promise.resolve('__ORCA_RG_CACHE__REFS_OK')
    })
    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', {})

    const refScan = scripts().find((s) => s.includes('REF %s')) ?? ''
    expect(refScan).toContain('.ripgrep-ref-*')
    expect(refScan).toContain('${f##*/.ripgrep-ref-}')
  })

  // Why the whole pass and not just that directory: a relay deployed by an older Orca records no
  // reference, so its binary cannot be identified -- and guessing is what breaks a live search.
  it('collects nothing when any relay directory cannot be accounted for', async () => {
    reply([CURRENT, SUPERSEDED], 'unreadable')

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why a readable RECHECK behind an unreadable first scan: with both unreadable, the restore in
  // removeUnreferencedEntry hides a missing up-front guard, and the test passes either way. This
  // shape is the only one that fails if the pass stops treating an unaccountable scan as fatal.
  it('does not even tombstone when the first reference scan is unreadable', async () => {
    execCommandMock.mockReset()
    let refCalls = 0
    execCommandMock.mockImplementation((_conn: unknown, command: string) => {
      const text = String(command)
      if (text.includes('ENTRY %s')) {
        return Promise.resolve(`ENTRY ${SUPERSEDED}\n__ORCA_RG_CACHE__LIST_OK`)
      }
      if (text.includes('REF %s')) {
        refCalls += 1
        return Promise.resolve(
          refCalls === 1 ? '__ORCA_RG_CACHE__REFS_ERR' : '__ORCA_RG_CACHE__REFS_OK'
        )
      }
      if (text.includes('MOVED')) {
        return Promise.resolve('MOVED')
      }
      return Promise.resolve('')
    })

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', {})

    expect(removedTrees()).toEqual([])
    expect(scripts().filter((s) => s.includes('MOVED'))).toEqual([])
  })

  it('keeps the pinned build even when nothing references it yet', async () => {
    reply([CURRENT], [])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why restore rather than proceed: a deploy that read the entry as present can still be writing
  // its marker, and the recheck is the only place that race becomes visible.
  it('restores a tombstoned build when the recheck finds a new reference', async () => {
    execCommandMock.mockReset()
    let refCalls = 0
    execCommandMock.mockImplementation((_conn: unknown, command: string) => {
      const text = String(command)
      if (text.includes('ENTRY %s')) {
        return Promise.resolve(`ENTRY ${SUPERSEDED}\n__ORCA_RG_CACHE__LIST_OK`)
      }
      if (text.includes('REF %s')) {
        refCalls += 1
        return Promise.resolve(
          refCalls === 1
            ? '__ORCA_RG_CACHE__REFS_OK'
            : `REF ${SUPERSEDED}\n__ORCA_RG_CACHE__REFS_OK`
        )
      }
      if (text.includes('MOVED')) {
        return Promise.resolve('MOVED')
      }
      return Promise.resolve('')
    })

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', {})

    expect(removedTrees()).toEqual([])
    // Moved out, then moved back.
    expect(scripts().filter((s) => s.includes('MOVED'))).toHaveLength(2)
  })

  // Why tie this to the platform list: a platform the entry pattern did not know would make the
  // reference scan read as unreadable, and the pass then collects nothing at all -- every
  // superseded build on that host leaks, silently, with no other test failing.
  it('accepts an entry for every bundled platform', async () => {
    for (const platform of BUNDLED_RIPGREP_PLATFORMS) {
      const entry = `c0ffee0123456789-${platform}`
      reply([entry], [entry])

      await gcRemoteRipgrepCache(conn, LINUX, '/home/me', {})

      // Referenced, so not collected -- but it had to parse as an entry to be considered at all.
      expect(removedTrees()).toEqual([])
      expect(scripts().some((s) => s.includes('REF %s'))).toBe(true)
    }
  })

  it('only mints entry names it could have written', async () => {
    reply([CURRENT, '../../etc', 'not-an-entry'], [CURRENT])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why Windows gets the same coverage and not a gate: leaving one dialect uncollected means the
  // leak simply moves to Windows remotes, where a `.exe` is the larger of the two builds.
  it('collects an unreferenced build on Windows remotes too', async () => {
    const WIN_CURRENT = 'c0ffee0123456789-win32-x64'
    const WIN_OLD = 'dead000000000000-win32-x64'
    execCommandMock.mockReset()
    execCommandMock.mockImplementation((_conn: unknown, command: string) => {
      const text = decodeRemotePowerShellScript(String(command)) ?? String(command)
      if (text.includes("'ENTRY '")) {
        return Promise.resolve(`ENTRY ${WIN_CURRENT}\nENTRY ${WIN_OLD}\n__ORCA_RG_CACHE__LIST_OK`)
      }
      if (text.includes("'REF '")) {
        return Promise.resolve(`REF ${WIN_CURRENT}\n__ORCA_RG_CACHE__REFS_OK`)
      }
      if (text.includes('MOVED')) {
        return Promise.resolve('MOVED')
      }
      return Promise.resolve('')
    })

    await gcRemoteRipgrepCache(conn, WINDOWS, 'C:/Users/me', { pinnedEntry: WIN_CURRENT })

    const removals = scripts()
      .map((s) => decodeRemotePowerShellScript(s) ?? s)
      .filter(
        (s) => s.includes('Remove-Item') && s.includes('.rg-gc-') && !s.includes('AddMinutes')
      )
    expect(removals).toHaveLength(1)
    expect(removals[0]).toContain(WIN_OLD)
  })

  // Why: PowerShell writes every uncaptured value to stdout, so a listing that forgot its token
  // prefix would mix cmdlet output into the entry list and feed `Remove-Item` a foreign name.
  it('prefixes every Windows listing line with its token', async () => {
    execCommandMock.mockReset()
    execCommandMock.mockResolvedValue('__ORCA_RG_CACHE__LIST_OK')

    await gcRemoteRipgrepCache(conn, WINDOWS, 'C:/Users/me', {})

    const listing = decodeRemotePowerShellScript(scripts()[0]) ?? ''
    expect(listing).toContain("'ENTRY ' + $_.Name")
    expect(listing).toContain('__ORCA_RG_CACHE__LIST_OK')
  })
})
