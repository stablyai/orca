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
// Why importOriginal: the site-config tests need a real tmpdir(), and a bare factory would replace
// the whole module and leave every other export undefined.
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
    // Why: the default search still reads /etc/ssh/ssh_config, which the
    // SshResolvedConfig.gssapiAuthentication contract depends on.
    expect(sshGArgsForHost('prod')).toEqual(['-G', '--', 'prod'])
  })

  it('pins the HOME config when it diverges from the passwd home', () => {
    homedirMock.mockReturnValue('/tmp/e2e-home')

    expect(sshGArgsForHost('prod')).toEqual(['-F', '/tmp/e2e-home/.ssh/config', '-G', '--', 'prod'])
    expect(existsSyncMock).toHaveBeenCalledWith('/tmp/e2e-home/.ssh/config')
  })

  it('falls back to passwd-home resolution when the HOME config is absent', () => {
    // Why: ssh exits 255 on a missing -F file, so a divergent HOME without a
    // config must not pin one. The picker lists nothing here, so the wider
    // passwd-home resolution never mints a target.
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

/**
 * Whether the system-wide ssh_config could restrict host keys.
 *
 * `-F` excludes /etc/ssh/ssh_config as well as the per-user file, and there is no ssh-only way to
 * read one while suppressing the other — `-F /dev/null` reports built-in defaults, which would make
 * every machine look permissive. So the file is read, and the question asked is deliberately weaker
 * than "what is the policy": anything ambiguous keeps the caller fail-closed.
 */
describe('siteConfigMayRestrictHostKeys', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-site-ssh-config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('answers no when there is no system config at all', async () => {
    // The case that used to lock people out: nothing to be blind to.
    await expect(siteConfigMayRestrictHostKeys([join(dir, 'absent')])).resolves.toBe(false)
  })

  it('answers no for a config that says nothing about host keys', async () => {
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Host *\n    SendEnv LANG LC_*\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
  })

  it('answers yes when the directive is present, whatever its value', async () => {
    // The value is not parsed on purpose: presence alone is enough to stay strict.
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Host *\n    StrictHostKeyChecking no\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('follows the Include OpenSSH ships by default', async () => {
    // macOS and most distros ship `Include /etc/ssh/ssh_config.d/*`, so missing this would read as
    // "no policy" on nearly every machine that has one.
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
    // OpenSSH resolves a relative Include against a FIXED base (SSHDIR), not the including file's
    // own directory — verified against 10.2p1, where a nested `Include sibling` picked up the
    // sibling of the TOP config. Passing dirname(file) agreed at depth 1 and diverged below it, so
    // this directive was silently missed and the scanner answered "no site policy".
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Include nested/inner\n', 'utf-8')
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'nested', 'inner'), 'Include sibling\n', 'utf-8')
    await writeFile(join(dir, 'sibling'), 'StrictHostKeyChecking yes\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('stays strict for a glob it cannot expand', async () => {
    // `?` and `[…]` are globs OpenSSH honours (10.2p1 applies `Include /tmp/b/?.conf`), but only
    // `*` is expanded here. Treated as a literal path they resolve to nothing, and "nothing there"
    // is indistinguishable from "no policy" — so an unexpanded glob has to count as doubt.
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include ${join(dir, '?.conf')}\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('stays strict for an Include path it would have to expand tokens in', async () => {
    // `~` and `%d`-style tokens expand before OpenSSH uses the path. Joining them verbatim produced
    // a path that cannot exist, which is the same fail-open as the glob above.
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Include ~/.ssh/site.conf\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('follows a quoted Include path that contains a space', async () => {
    // OpenSSH honours the quoted form — 10.2p1 applies `Include "<dir>/sp ace/x.conf"`. Splitting on
    // whitespace before unquoting shredded it into two tokens that resolved to nothing, and two
    // missing paths read as "no site policy". Likelier on Windows, where `C:\\Program Files` is
    // ordinary. The unquoted form still splits, which is also what OpenSSH does.
    const spaced = join(dir, 'my confs')
    await mkdir(spaced, { recursive: true })
    await writeFile(join(spaced, 'site.conf'), 'StrictHostKeyChecking accept-new\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include "${join(spaced, 'site.conf')}"\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('follows a single-quoted Include path that contains a space', async () => {
    // OpenSSH quotes with either character — 10.2p1 honours the single-quoted form too. Modelling
    // only double quotes left this splitting into fragments that resolve to nothing, which is the
    // same fail-open the double-quote case was raised for.
    const spaced = join(dir, 'sq ace')
    await mkdir(spaced, { recursive: true })
    await writeFile(join(spaced, 'site.conf'), 'StrictHostKeyChecking yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include '${join(spaced, 'site.conf')}'\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('follows an Include path whose space is backslash-escaped', async () => {
    // The third spelling OpenSSH honours (verified against 10.2p1).
    const spaced = join(dir, 'esc ape')
    await mkdir(spaced, { recursive: true })
    await writeFile(join(spaced, 'site.conf'), 'StrictHostKeyChecking yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include ${join(spaced, 'site.conf').replace(' ', '\\ ')}\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(true)
  })

  it('keeps backslashes that are path separators rather than escapes', async () => {
    // The Windows trap: the site config lives at C:\\ProgramData\\ssh\\ssh_config, so treating every
    // backslash as an escape would eat the separators of any Include beneath it, resolve to nothing,
    // and reintroduce the fail-open on the platform this matters most for. Only a backslash before
    // whitespace escapes.
    //
    // Discriminating on POSIX by giving the file a literal backslash in its NAME, which is legal
    // here: preserved, the path resolves and the directive is found; swallowed, it resolves to
    // `winlikesite.conf`, which does not exist — and a bare `.resolves.toBe(false)` could not tell
    // those apart, since a missing path answers false either way.
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
    // The lockout this scanner exists to avoid: answering "doubt" for `Include "/etc/ssh/x.conf"`
    // would punish an ordinary quoted config that plainly says nothing about host keys.
    const included = join(dir, 'plain.conf')
    await writeFile(included, 'Compression yes\n', 'utf-8')
    const file = join(dir, 'ssh_config')
    await writeFile(file, `Include "${included}"\n`, 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
  })

  it('ignores a commented-out directive', async () => {
    // A commented directive is not a policy. Reading it as one would reinstate the lockout for
    // anyone whose distro ships the line commented, which is the common shape.
    const file = join(dir, 'ssh_config')
    await writeFile(file, 'Host *\n    # StrictHostKeyChecking yes\n', 'utf-8')

    await expect(siteConfigMayRestrictHostKeys([file])).resolves.toBe(false)
  })

  it('sees the directive inside Host and Match blocks', async () => {
    // No attempt is made to evaluate whether the block applies to this host — presence anywhere is
    // enough, because guessing wrong in the permissive direction is the failure that matters.
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

/**
 * The measured oracle. Every expectation below was produced by running a real `ssh` and reading what
 * it resolved to — OpenSSH 10.2p1 for the POSIX rows, Windows OpenSSH for the win32 ones — not by
 * reading the source or reasoning from shell conventions.
 *
 * Pinned because the tokenizer's whole job is to agree with `ssh` about which file it would read: a
 * spelling we disagree on resolves for ssh and misses for us, and a path that misses is silently
 * read as "there is no site policy". Every fix in this area has been one of these.
 */
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
    // Measured: `"a\ b.conf"` and `'a\ b.conf'` both resolve to the SPACE-named file, not the
    // backslash-named one. Shell-style single-quote literalness would have been the wrong model.
    expect(posix('"/etc/a\\ b.conf"')).toEqual(['/etc/a b.conf'])
    expect(posix("'/etc/a\\ b.conf'")).toEqual(['/etc/a b.conf'])
  })

  it('treats a single quote inside double quotes as an ordinary character', () => {
    // Measured as resolved. One quote-state variable reproduces this; two independent toggles would
    // have closed the double quote early and split the path.
    expect(posix('"/etc/it\'s here/x.conf"')).toEqual(["/etc/it's here/x.conf"])
  })

  it('splits an UNQUOTED space into two paths, as ssh does', () => {
    expect(posix('/etc/a.conf /etc/b.conf')).toEqual(['/etc/a.conf', '/etc/b.conf'])
  })

  it('answers doubt on POSIX for a backslash before an ordinary character', () => {
    // Measured: ssh resolves `conf\.d` as `conf.d`, and four backslashes are needed to survive as
    // one — argv_split and glob() each eat a level. Preserving it means looking for a path with a
    // literal backslash, missing, and reading "no site policy", which is the fail-open. We answer
    // uncertain rather than reimplement two rounds of glob escaping.
    expect(posix('/etc/ssh/conf\\.d/x.conf')).toBeNull()
    expect(posix('/etc/ssh/a\\\\b/x.conf')).toBeNull()
  })

  it('keeps backslashes as separators on Windows', () => {
    // Measured on Windows OpenSSH: `Include C:\\Users\\...\\x.conf` resolves. Answering doubt here
    // would reinstate the lockout, since every absolute Windows Include contains backslashes.
    expect(windows('C:\\Users\\neil\\conf\\x.conf')).toEqual(['C:\\Users\\neil\\conf\\x.conf'])
    // Measured too: an escaped space still escapes, even amid separators.
    expect(windows('C:\\Users\\neil\\sp\\ ace\\x.conf')).toEqual([
      'C:\\Users\\neil\\sp ace\\x.conf'
    ])
  })

  it('answers doubt when a quote never closes, which ssh rejects outright', () => {
    expect(posix('"/etc/ssh/x.conf')).toBeNull()
    expect(windows('"C:\\x.conf')).toBeNull()
  })

  it('returns an ordinary path unchanged, on both platforms', () => {
    // The invariant every fix in this area has had to preserve: no whitespace, quote or backslash
    // means one token, byte-for-byte.
    for (const path of ['/etc/ssh/ssh_config.d/10-site.conf', 'relative/x.conf', 'x']) {
      expect(posix(path)).toEqual([path])
      expect(windows(path)).toEqual([path])
    }
  })
})
