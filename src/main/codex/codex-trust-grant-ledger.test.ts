import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  binaryStampsMatch,
  getCodexTrustGrantLedgerPath,
  readCodexTrustGrantLedgerHome,
  removeCodexTrustGrantLedgerHome,
  writeCodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'

let userDataDir: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-trust-ledger-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
})

afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('codex trust grant ledger', () => {
  it('round-trips per-home grant records and isolates homes', () => {
    const hostHome = join(userDataDir, 'codex-runtime-home', 'home')
    const wslHome = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\runtime-home'
    writeCodexTrustGrantLedgerHome(hostHome, {
      binary: { kind: 'native', path: '/usr/local/bin/codex', size: 10, mtimeMs: 20 },
      entries: { 'k1:session_start:0:0': { signature: 'sig-1', trustedHash: 'sha256:a' } }
    })
    writeCodexTrustGrantLedgerHome(wslHome, {
      binary: {
        kind: 'wsl',
        distro: 'Ubuntu',
        path: '/home/alice/.local/bin/codex',
        version: 'codex-cli 1.2.3'
      },
      entries: {
        '/home/alice/hooks.json:stop:0:0': { signature: 'sig-2', trustedHash: 'sha256:b' }
      }
    })

    expect(readCodexTrustGrantLedgerHome(hostHome)?.entries['k1:session_start:0:0']).toEqual({
      signature: 'sig-1',
      trustedHash: 'sha256:a'
    })
    expect(readCodexTrustGrantLedgerHome(wslHome)?.binary).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      path: '/home/alice/.local/bin/codex',
      version: 'codex-cli 1.2.3'
    })

    removeCodexTrustGrantLedgerHome(hostHome)
    expect(readCodexTrustGrantLedgerHome(hostHome)).toBeNull()
    expect(readCodexTrustGrantLedgerHome(wslHome)).not.toBeNull()
  })

  it('treats Windows path-case variants as the same home', () => {
    const home = 'C:\\Users\\Alice\\AppData\\Roaming\\orca\\codex-runtime-home\\home'
    writeCodexTrustGrantLedgerHome(home, { binary: null, entries: {} })
    expect(
      readCodexTrustGrantLedgerHome('c:/users/alice/appdata/roaming/orca/codex-runtime-home/home')
    ).not.toBeNull()
  })

  it('tolerates a corrupt ledger file', () => {
    const home = join(userDataDir, 'codex-runtime-home', 'home')
    writeFileSync(getCodexTrustGrantLedgerPath(), 'not-json{{{')
    expect(readCodexTrustGrantLedgerHome(home)).toBeNull()
    // Why: a corrupt file must not block recording the next verified grant.
    writeCodexTrustGrantLedgerHome(home, { binary: null, entries: {} })
    expect(readCodexTrustGrantLedgerHome(home)).not.toBeNull()
  })

  it('matches binary stamps only on identical identity', () => {
    const stamp = { kind: 'native' as const, path: '/bin/codex', size: 1, mtimeMs: 2 }
    const wslStamp = {
      kind: 'wsl' as const,
      distro: 'Ubuntu',
      path: '/home/alice/.local/bin/codex',
      version: 'codex-cli 1.2.3'
    }
    expect(binaryStampsMatch(stamp, { ...stamp })).toBe(true)
    expect(binaryStampsMatch(stamp, { ...stamp, mtimeMs: 3 })).toBe(false)
    expect(binaryStampsMatch(stamp, { ...stamp, size: 9 })).toBe(false)
    expect(binaryStampsMatch(stamp, { ...stamp, path: '/other/codex' })).toBe(false)
    expect(binaryStampsMatch(stamp, null)).toBe(false)
    expect(binaryStampsMatch(null, null)).toBe(true)
    expect(binaryStampsMatch(wslStamp, { ...wslStamp })).toBe(true)
    expect(binaryStampsMatch(wslStamp, { ...wslStamp, distro: 'Debian' })).toBe(false)
    expect(binaryStampsMatch(wslStamp, { ...wslStamp, path: '/opt/codex' })).toBe(false)
    expect(binaryStampsMatch(wslStamp, { ...wslStamp, version: 'codex-cli 1.2.4' })).toBe(false)
    expect(binaryStampsMatch(wslStamp, stamp)).toBe(false)
  })
})
