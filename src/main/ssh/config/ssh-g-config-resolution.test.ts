import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type NodeOsModule = typeof NodeOs

const { existsSyncMock, homedirMock, userInfoMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(() => true),
  homedirMock: vi.fn<() => string>(() => '/home/env'),
  userInfoMock: vi.fn<() => { homedir: string }>(() => ({ homedir: '/home/env' }))
}))

vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
// Retain real os exports because site-policy fixtures need tmpdir.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<NodeOsModule>()),
  homedir: homedirMock,
  userInfo: userInfoMock
}))

import {
  siteConfigMayRestrictHostKeys,
  splitIncludeArguments,
  sshGArgsForHost
} from './ssh-g-config-resolution'

describe('sshGArgsForHost', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockReturnValue(true)
    homedirMock.mockReset().mockReturnValue('/home/env')
    userInfoMock.mockReset().mockReturnValue({ homedir: '/home/env' })
  })

  it('keeps OpenSSH default resolution when HOME matches the passwd home', () => {
    // Default resolution must retain system GSSAPI defaults.
    expect(sshGArgsForHost('prod')).toEqual(['-G', '--', 'prod'])
  })

  it('pins the HOME config when it diverges from the passwd home', () => {
    homedirMock.mockReturnValue('/tmp/e2e-home')

    expect(sshGArgsForHost('prod')).toEqual(['-F', '/tmp/e2e-home/.ssh/config', '-G', '--', 'prod'])
    expect(existsSyncMock).toHaveBeenCalledWith('/tmp/e2e-home/.ssh/config')
  })

  it('falls back to passwd-home resolution when the HOME config is absent', () => {
    // A missing -F file makes ssh exit255; the picker cannot list passwd-home aliases anyway.
    homedirMock.mockReturnValue('/tmp/e2e-home')
    existsSyncMock.mockReturnValue(false)

    expect(sshGArgsForHost('prod')).toEqual(['-G', '--', 'prod'])
  })

  it('treats an unavailable passwd entry as a HOME match', () => {
    userInfoMock.mockImplementation(() => {
      throw new Error('getpwuid failed')
    })

    expect(sshGArgsForHost('prod')).toEqual(['-G', '--', 'prod'])
  })

  it('does not let a leading-dash alias become a flag', () => {
    homedirMock.mockReturnValue('/tmp/e2e-home')

    expect(sshGArgsForHost('-oProxyCommand=touch /tmp/pwned')).toEqual([
      '-F',
      '/tmp/e2e-home/.ssh/config',
      '-G',
      '--',
      '-oProxyCommand=touch /tmp/pwned'
    ])
  })
})

/** -F excludes user and system config; read site policy separately and fail closed on uncertainty. */
describe('siteConfigMayRestrictHostKeys', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-site-ssh-config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('answers no when there is no system config at all', async () => {
    await expect(siteConfigMayRestrictHostKeys([join(dir, 'absent')])).resolves.toBe(false)
  })

  it('answers no for a config that says nothing about host keys', async () => {
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Host *\n    SendEnv LANG LC_*\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
  })

  it('answers yes when the directive is present, whatever its value', async () => {
    // Any mention retains strict policy; its value is intentionally unparsed.
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Host *\n    StrictHostKeyChecking no\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
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

  it('answers no when an Included directory holds nothing relevant', async () => {
    const includeDir = join(dir, 'ssh_config.d')
    await mkdir(includeDir)
    await writeFile(join(includeDir, '10-site.conf'), 'SendEnv LANG\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Include ssh_config.d/*\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
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

  it('stays strict for an Include path it would have to expand tokens in', async () => {
    // Unexpanded ~/% tokens must fail closed rather than look like absent files.
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Include ~/.ssh/site.conf\n', 'utf-8')

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

  it('follows a single-quoted Include path that contains a space', async () => {
    // Single-quoted spaces are measured OpenSSH behavior too.
    const spaced = join(dir, 'sq ace')
    await mkdir(spaced, { recursive: true })
    await writeFile(join(spaced, 'site.conf'), 'StrictHostKeyChecking yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include '${join(spaced, 'site.conf')}'\n`, 'utf-8')

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

  it('keeps backslashes that are path separators rather than escapes', async () => {
    // Preserve Windows separators; model one as a literal POSIX filename character so swallowed backslashes would miss the strict directive.
    const literal = join(dir, 'winlike\\site.conf')
    await writeFile(literal, 'StrictHostKeyChecking yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include ${literal}\n`, 'utf-8')

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

  it('ignores a commented-out directive', async () => {
    // Commented directives are not policy.
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Host *\n    # StrictHostKeyChecking yes\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
  })

  it('sees the directive inside Host and Match blocks', async () => {
    // Any host block can carry policy; this scan deliberately avoids guessing applicability.
    const hostScoped = join(dir, 'host-scoped')
    await writeFile(hostScoped, 'Host prod\n    StrictHostKeyChecking yes\n', 'utf-8')
    const matchScoped = join(dir, 'match-scoped')
    await writeFile(matchScoped, 'Match exec "true"\n    StrictHostKeyChecking yes\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([hostScoped])).resolves.toBe(true)
    await expect(siteConfigMayRestrictHostKeys([matchScoped])).resolves.toBe(true)
  })

  it('sees the equals form', async () => {
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'StrictHostKeyChecking=yes\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('does not match a directive that merely starts the same way', async () => {
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'StrictHostKeyCheckingExtended yes\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
  })

  it('follows a nested Include', async () => {
    const inner = join(dir, 'inner')
    await writeFile(inner, 'StrictHostKeyChecking yes\n', 'utf-8')
    const middle = join(dir, 'middle')
    await writeFile(middle, `Include ${inner}\n`, 'utf-8')
    const outer = join(dir, 'ssh_config')
    await writeFile(outer, `Include ${middle}\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([outer])).resolves.toBe(true)
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

  it('holds a spaced path together in all three spellings both platforms honour', () => {
    for (const split of [posix, windows]) {
      expect(split('"/etc/ssh/sp ace/x.conf"')).toEqual(['/etc/ssh/sp ace/x.conf'])
      expect(split("'/etc/ssh/sp ace/x.conf'")).toEqual(['/etc/ssh/sp ace/x.conf'])
      expect(split('/etc/ssh/sp\\ ace/x.conf')).toEqual(['/etc/ssh/sp ace/x.conf'])
    }
  })

  it('consumes an escaped space INSIDE either quote, as ssh does', () => {
    // Measured ssh treats backslash-space as a space under both quote styles.
    expect(posix('"/etc/a\\ b.conf"')).toEqual(['/etc/a b.conf'])
    expect(posix("'/etc/a\\ b.conf'")).toEqual(['/etc/a b.conf'])
  })

  it('treats a single quote inside double quotes as an ordinary character', () => {
    // Opposite quotes inside a quoted path must remain literal.
    expect(posix('"/etc/it\'s here/x.conf"')).toEqual(["/etc/it's here/x.conf"])
  })

  it('splits an UNQUOTED space into two paths, as ssh does', () => {
    expect(posix('/etc/a.conf /etc/b.conf')).toEqual(['/etc/a.conf', '/etc/b.conf'])
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

  it('answers doubt when a quote never closes, which ssh rejects outright', () => {
    expect(posix('"/etc/ssh/x.conf')).toBeNull()
    expect(windows('"C:\\x.conf')).toBeNull()
  })

  it('returns an ordinary path unchanged, on both platforms', () => {
    for (const path of ['/etc/ssh/ssh_config.d/10-site.conf', 'relative/x.conf', 'x']) {
      expect(posix(path)).toEqual([path])
      expect(windows(path)).toEqual([path])
    }
  })
})
