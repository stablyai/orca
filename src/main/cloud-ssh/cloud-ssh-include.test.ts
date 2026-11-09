import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOUD_SSH_INCLUDE_MARKER,
  addCloudSshInclude,
  hasCloudSshInclude,
  removeCloudSshInclude,
  withCloudSshInclude,
  withoutCloudSshInclude
} from './cloud-ssh-include'

const ORCA_CONFIG = '/Users/me/Library/Application Support/orca/cloud-ssh/config'
const USER_CONFIG = 'Host work\n  HostName work.example.com\n  User me\n'

let dir: string | null = null
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
})

describe('withCloudSshInclude', () => {
  it('puts the Include first, before any Host block can scope it', () => {
    const next = withCloudSshInclude(USER_CONFIG, ORCA_CONFIG)
    expect(next.startsWith(`${CLOUD_SSH_INCLUDE_MARKER}\nInclude "${ORCA_CONFIG}"\n\n`)).toBe(true)
    expect(next.endsWith(USER_CONFIG)).toBe(true)
  })

  it('is idempotent', () => {
    const once = withCloudSshInclude(USER_CONFIG, ORCA_CONFIG)
    expect(withCloudSshInclude(once, ORCA_CONFIG)).toBe(once)
    expect(hasCloudSshInclude(once, ORCA_CONFIG)).toBe(true)
  })

  it('keeps Windows line endings', () => {
    const next = withCloudSshInclude(USER_CONFIG.replaceAll('\n', '\r\n'), ORCA_CONFIG)
    expect(next).toContain(`Include "${ORCA_CONFIG}"\r\n`)
    expect(next).not.toMatch(/[^\r]\n/)
  })

  it('round-trips: removing it restores the user’s file byte for byte', () => {
    expect(withoutCloudSshInclude(withCloudSshInclude(USER_CONFIG, ORCA_CONFIG), ORCA_CONFIG)).toBe(
      USER_CONFIG
    )
    expect(withoutCloudSshInclude(withCloudSshInclude('', ORCA_CONFIG), ORCA_CONFIG)).toBe('')
  })

  it('leaves a look-alike line the user wrote for another file alone', () => {
    const other = `Include "/elsewhere/config"\n${USER_CONFIG}`
    expect(withoutCloudSshInclude(other, ORCA_CONFIG)).toBe(other)
  })
})

describe('add/removeCloudSshInclude', () => {
  it('creates ~/.ssh/config privately when there is none', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-ssh-include-'))
    const file = join(dir, '.ssh', 'config')
    await addCloudSshInclude(file, ORCA_CONFIG)
    expect(readFileSync(file, 'utf8')).toContain(`Include "${ORCA_CONFIG}"`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('updates a symlinked config at its target and keeps the link', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-ssh-include-'))
    const target = join(dir, 'dotfiles-ssh-config')
    writeFileSync(target, USER_CONFIG, { mode: 0o644 })
    const link = join(dir, 'config')
    symlinkSync(target, link)
    await addCloudSshInclude(link, ORCA_CONFIG)
    expect(readFileSync(target, 'utf8')).toContain('Include')
    expect(statSync(target).mode & 0o777).toBe(0o644)
    await removeCloudSshInclude(link, ORCA_CONFIG)
    expect(readFileSync(target, 'utf8')).toBe(USER_CONFIG)
  })
})
