import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS,
  listGuestCodexAccountHomes,
  resolveGuestCodexAccountHome
} from './guest-codex-account-homes'

describe.skipIf(process.platform === 'win32')('guest Codex account homes', () => {
  let home: string
  let root: string

  function makeAccountHome(accountId: string, marker = `${accountId}\n`): string {
    const accountHome = join(root, accountId, 'home')
    mkdirSync(accountHome, { recursive: true })
    writeFileSync(join(accountHome, '.orca-managed-home'), marker, 'utf-8')
    return accountHome
  }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-guest-codex-homes-')))
    root = join(home, ...GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS)
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('accepts an account home owned by its marker', () => {
    const accountHome = makeAccountHome('account-1')
    expect(resolveGuestCodexAccountHome(accountHome, home)).toBe(accountHome)
    expect(resolveGuestCodexAccountHome(` ${accountHome} `, home)).toBe(accountHome)
  })

  it('refuses a home whose marker names another account', () => {
    expect(resolveGuestCodexAccountHome(makeAccountHome('account-1', 'account-2\n'), home)).toBe(
      null
    )
  })

  it('refuses a user CODEX_HOME outside the account root', () => {
    const own = join(home, 'my-codex', 'home')
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, '.orca-managed-home'), 'my-codex\n', 'utf-8')
    expect(resolveGuestCodexAccountHome(own, home)).toBe(null)
    expect(resolveGuestCodexAccountHome(join(home, '.codex'), home)).toBe(null)
    expect(resolveGuestCodexAccountHome(undefined, home)).toBe(null)
    expect(resolveGuestCodexAccountHome('relative/home', home)).toBe(null)
    expect(resolveGuestCodexAccountHome(join(root, 'a', 'b', 'home'), home)).toBe(null)
    expect(resolveGuestCodexAccountHome('/mnt/stalled-share/home', home)).toBe(null)
  })

  it('refuses an account entry linked out of the root', () => {
    const outside = join(home, 'elsewhere', 'home')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '.orca-managed-home'), 'linked\n', 'utf-8')
    symlinkSync(join(home, 'elsewhere'), join(root, 'linked'))
    expect(resolveGuestCodexAccountHome(join(root, 'linked', 'home'), home)).toBe(null)
  })

  it('lists only owned homes', () => {
    const first = makeAccountHome('account-1')
    const second = makeAccountHome('account-2')
    makeAccountHome('account-3', 'someone-else\n')
    mkdirSync(join(root, 'no-home'))
    expect(listGuestCodexAccountHomes(home).sort()).toEqual([first, second].sort())
  })

  it('lists nothing where no account root exists', () => {
    rmSync(root, { recursive: true })
    expect(listGuestCodexAccountHomes(home)).toEqual([])
  })
})
