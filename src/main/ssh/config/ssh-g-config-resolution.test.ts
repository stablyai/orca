import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type NodeOsModule = typeof NodeOs

const { existsSyncMock, homedirMock, userInfoMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(() => true),
  homedirMock: vi.fn<() => string>(() => '/home/env'),
  userInfoMock: vi.fn<() => { homedir: string; username?: string }>(() => ({
    homedir: '/home/env'
  }))
}))

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
// Retain real os exports because site-policy fixtures need tmpdir.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<NodeOsModule>()),
  homedir: homedirMock,
  userInfo: userInfoMock
}))

import { siteConfigMayRestrictHostKeys, splitIncludeArguments } from './ssh-g-config-resolution'

describe('siteConfigMayRestrictHostKeys', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-site-ssh-config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('follows the Include OpenSSH ships by default', async () => {
    // Distro defaults commonly Include ssh_config.d; skipping it would miss site policy.
    const includeDir = join(dir, 'ssh_config.d')
    await mkdir(includeDir)
    await writeFile(join(includeDir, '10-site.conf'), 'StrictHostKeyChecking yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Include ssh_config.d/*\nHost *\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('finds a directive behind a RELATIVE Include nested two deep', async () => {
    // Measured OpenSSH10.2p1 resolves nested relative Includes against fixed SSHDIR, not each including directory.
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Include nested/inner\n', 'utf-8')
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'nested', 'inner'), 'Include sibling\n', 'utf-8')
    await writeFile(join(dir, 'sibling'), 'StrictHostKeyChecking yes\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('stays strict for a glob it cannot expand', async () => {
    // Unexpanded ?/[] globs are uncertainty; treating them literally could hide policy.
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include ${join(dir, '?.conf')}\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('follows a quoted Include path that contains a space', async () => {
    // OpenSSH honors quoted spaces; splitting early turns real policy files into missing fragments.
    const spaced = join(dir, 'my confs')
    await mkdir(spaced, { recursive: true })
    await writeFile(join(spaced, 'site.conf'), 'StrictHostKeyChecking accept-new\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include "${join(spaced, 'site.conf')}"\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('follows an Include path whose space is backslash-escaped', async () => {
    const spaced = join(dir, 'esc ape')
    await mkdir(spaced, { recursive: true })
    await writeFile(join(spaced, 'site.conf'), 'StrictHostKeyChecking yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include ${join(spaced, 'site.conf').replace(' ', '\\ ')}\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('stays strict when an Include quote never closes', async () => {
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include "${join(dir, 'unterminated.conf')}\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('still reads a quoted path with no space, rather than calling every quote doubt', async () => {
    // A readable quoted Include without host-key directives must not cause lockout.
    const included = join(dir, 'plain.conf')
    await writeFile(included, 'Compression yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include "${included}"\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
  })

  it('terminates on an Include cycle', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    await writeFile(a, `Include ${b}\n`, 'utf-8')
    await writeFile(b, `Include ${a}\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([a])).resolves.toBe(false)
  })

  it('treats an unreadable config as doubt rather than permission', async () => {
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Host *\n', 'utf-8')
    await chmod(file, 0o000)

    try {
      await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
    } finally {
      await chmod(file, 0o600)
    }
  })
})

/** Vectors measured against POSIX OpenSSH10.2p1 and Windows OpenSSH; tokenizer drift can turn existing policy into apparent absence. */
describe('splitIncludeArguments against a measured ssh', () => {
  const posix = (pattern: string) => splitIncludeArguments(pattern, false)
  const windows = (pattern: string) => splitIncludeArguments(pattern, true)

  it('consumes an escaped space INSIDE either quote, as ssh does', () => {
    // Measured ssh treats backslash-space as a space under both quote styles.
    expect(posix('"/etc/a\\ b.conf"')).toEqual(['/etc/a b.conf'])
    expect(posix("'/etc/a\\ b.conf'")).toEqual(['/etc/a b.conf'])
  })

  it('answers doubt on POSIX for a backslash before an ordinary character', () => {
    // POSIX argv_split and glob each consume backslashes; unsupported escaping stays uncertain rather than resolving a false absent path.
    expect(posix('/etc/ssh/conf\\.d/x.conf')).toBeNull()
    expect(posix('/etc/ssh/a\\\\b/x.conf')).toBeNull()
  })

  it('keeps backslashes as separators on Windows', () => {
    // Measured Windows OpenSSH preserves path separators.
    expect(windows('C:\\Users\\neil\\conf\\x.conf')).toEqual(['C:\\Users\\neil\\conf\\x.conf'])
    // Backslash-space still escapes amid Windows separators.
    expect(windows('C:\\Users\\neil\\sp\\ ace\\x.conf')).toEqual([
      'C:\\Users\\neil\\sp ace\\x.conf'
    ])
  })
})
