import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSshGOutput, type SshResolvedConfig } from './ssh-g-config-resolution'
import { matchKnownHosts, readHostKeyType, type KnownHostsEntry } from './ssh-known-hosts'
import {
  defaultKnownHostsFiles,
  loadKnownHostsEntries,
  loadKnownHostsEvidence,
  resolveKnownHostsFiles,
  resolveKnownHostsLookupHost
} from './ssh-known-hosts-source'

const ED_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const ED_B = 'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7'
const ED_C = 'AAAAC3NzaC1lZDI1NTE5AAAAIMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM'

const blob = (base64: string): Buffer => Buffer.from(base64, 'base64')
const hostLine = (hosts: string, key: string): string => `${hosts} ssh-ed25519 ${key}\n`

function verdict(entries: KnownHostsEntry[], host: string, key: string): string {
  return matchKnownHosts(entries, {
    host,
    port: 22,
    keyType: readHostKeyType(blob(key)) ?? '',
    key: blob(key)
  })
}

const roots: string[] = []
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-known-hosts-'))
  roots.push(root)
  return root
}

/** os.homedir() reads HOME on POSIX and USERPROFILE on Windows. */
function pretendHomeIs(path: string): void {
  process.env.HOME = path
  process.env.USERPROFILE = path
}

function resolvedConfig(overrides: Partial<SshResolvedConfig> = {}): SshResolvedConfig {
  return {
    hostname: 'prod.internal',
    port: 22,
    identityFile: [],
    identitiesOnly: false,
    forwardAgent: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    userKnownHostsFiles: [],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask',
    hashKnownHosts: false,
    updateHostKeys: 'no',
    ...overrides
  }
}

afterEach(async () => {
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    const value = savedHome[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveKnownHostsFiles', () => {
  it('splits the space-separated list ssh -G prints on one line', async () => {
    const resolved = parseSshGOutput(
      [
        'hostname prod.internal',
        'userknownhostsfile /a/known_hosts /a/known_hosts2 /b/known_hosts',
        'globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2'
      ].join('\n')
    )

    expect(resolved.userKnownHostsFiles).toEqual([
      '/a/known_hosts',
      '/a/known_hosts2',
      '/b/known_hosts'
    ])
    expect(await resolveKnownHostsFiles(resolved)).toEqual([
      '/a/known_hosts',
      '/a/known_hosts2',
      '/b/known_hosts',
      '/etc/ssh/ssh_known_hosts',
      '/etc/ssh/ssh_known_hosts2'
    ])
  })

  it('expands ~ in a reported path', async () => {
    pretendHomeIs(join('/pretend', 'home'))

    const resolved = parseSshGOutput('userknownhostsfile ~/.ssh/known_hosts ~/other_hosts')

    expect(await resolveKnownHostsFiles(resolved)).toEqual([
      join('/pretend', 'home', '.ssh', 'known_hosts'),
      join('/pretend', 'home', 'other_hosts')
    ])
  })

  it('keeps a double-quoted path containing spaces whole', async () => {
    const resolved = parseSshGOutput(
      'userknownhostsfile "/Users/dev/my hosts/known_hosts" /plain/known_hosts'
    )

    expect(await resolveKnownHostsFiles(resolved)).toEqual([
      '/Users/dev/my hosts/known_hosts',
      '/plain/known_hosts'
    ])
  })

  it('falls back to the default files when ssh -G reported nothing', async () => {
    pretendHomeIs(join('/pretend', 'home'))

    // Why not an empty list: no ssh, a non-zero exit or a timeout must not turn a host the user
    // already verified into first contact.
    expect(await resolveKnownHostsFiles(null)).toEqual([
      join('/pretend', 'home', '.ssh', 'known_hosts'),
      join('/pretend', 'home', '.ssh', 'known_hosts2')
    ])
    expect(defaultKnownHostsFiles()).toEqual(await resolveKnownHostsFiles(null))
  })

  it('drops an explicit none without falling back to the defaults', async () => {
    const resolved = parseSshGOutput(
      ['userknownhostsfile none', 'globalknownhostsfile /etc/ssh/ssh_known_hosts'].join('\n')
    )

    expect(await resolveKnownHostsFiles(resolved)).toEqual(['/etc/ssh/ssh_known_hosts'])
  })
})

// Verbatim `ssh -F <config> -G probe` output from OpenSSH_10.2p1 for a Host block setting HostName,
// HostKeyAlias, StrictHostKeyChecking accept-new, two UserKnownHostsFile paths and Port 2222.
// Hand-written fixtures elsewhere encode what we EXPECT ssh to print; this one is what it does
// print, which is the only version that catches us guessing the format wrong.
const REAL_SSH_G_OUTPUT = [
  'hostname real.example.com',
  'port 2222',
  'checkhostip no',
  'hashknownhosts no',
  'stricthostkeychecking accept-new',
  'updatehostkeys false',
  'hostkeyalias alias-host',
  'globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2',
  'userknownhostsfile /Users/nwparker/.ssh/kh_one /Users/nwparker/.ssh/kh_two'
].join('\n')

describe('parsing real ssh -G output', () => {
  const resolved = parseSshGOutput(REAL_SSH_G_OUTPUT)

  // Every file list arrives space-separated on ONE line, not repeated per line. Reading it as a
  // single path would silently consult nothing for anyone with more than one file configured.
  it('splits both known_hosts lists on one line each', async () => {
    expect(resolved.userKnownHostsFiles).toEqual([
      '/Users/nwparker/.ssh/kh_one',
      '/Users/nwparker/.ssh/kh_two'
    ])
    expect(resolved.globalKnownHostsFiles).toEqual([
      '/etc/ssh/ssh_known_hosts',
      '/etc/ssh/ssh_known_hosts2'
    ])
  })

  // Drives the whole strict branch; a miss defaults it to 'ask' and quietly loses the user's policy.
  it('reads StrictHostKeyChecking, including accept-new', async () => {
    expect(resolved.strictHostKeyChecking).toBe('accept-new')
  })

  // The one name that outranks the dialed host. A bastion tunnelled through localhost:port depends
  // on it, and it is the only field allowed to override what we key the lookup on.
  it('reads HostKeyAlias and prefers it for the lookup', async () => {
    expect(resolved.hostKeyAlias).toBe('alias-host')
    expect(resolveKnownHostsLookupHost(resolved, '127.0.0.1').host).toBe('alias-host')
  })

  it('reads the non-default port', async () => {
    expect(resolved.port).toBe(2222)
  })

  // Verified against OpenSSH 10.2p1 on port 2225 with HostKeyAlias=myalias: an entry keyed
  // `myalias` authenticates, one keyed `[myalias]:2225` gives "No ED25519 host key is known for
  // myalias". Since the first pass now decides as soon as it finds any entry, a leftover bracketed
  // line would BLOCK the bare lookup ssh actually performs.
  it('reports that the lookup came from an alias, so the port is not appended', async () => {
    expect(resolveKnownHostsLookupHost(resolved, '127.0.0.1').isHostKeyAlias).toBe(true)
  })

  it('reports no alias when the dialed host is used', async () => {
    expect(resolveKnownHostsLookupHost(null, '127.0.0.1').isHostKeyAlias).toBe(false)
  })
})

describe('loadKnownHostsEntries', () => {
  it('unions the entries of every file', async () => {
    const root = await createRoot()
    const userFile = join(root, 'known_hosts')
    const globalFile = join(root, 'ssh_known_hosts')
    await writeFile(userFile, hostLine('alpha.example', ED_A))
    await writeFile(globalFile, hostLine('beta.example', ED_B))

    const entries = await loadKnownHostsEntries([userFile, globalFile])

    expect(entries).toHaveLength(2)
    expect(verdict(entries, 'alpha.example', ED_A)).toBe('match')
    expect(verdict(entries, 'beta.example', ED_B)).toBe('match')
  })

  it('lets a hit in either file win over a disagreeing entry in the other', async () => {
    const root = await createRoot()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await writeFile(first, hostLine('shared.example', ED_A))
    await writeFile(second, hostLine('shared.example', ED_B))

    const entries = await loadKnownHostsEntries([first, second])

    expect(verdict(entries, 'shared.example', ED_A)).toBe('match')
    expect(verdict(entries, 'shared.example', ED_B)).toBe('match')
    // The union still detects a key neither file holds.
    expect(verdict(entries, 'shared.example', ED_C)).toBe('mismatch')
  })

  it('skips a missing file and keeps the rest', async () => {
    const root = await createRoot()
    const present = join(root, 'known_hosts')
    await writeFile(present, hostLine('alpha.example', ED_A))

    const entries = await loadKnownHostsEntries([join(root, 'absent'), present])

    expect(verdict(entries, 'alpha.example', ED_A)).toBe('match')
  })

  it('skips a path that is a directory', async () => {
    const root = await createRoot()
    const present = join(root, 'known_hosts')
    await mkdir(join(root, 'a_directory'))
    await writeFile(present, hostLine('alpha.example', ED_A))

    const entries = await loadKnownHostsEntries([join(root, 'a_directory'), present])

    expect(verdict(entries, 'alpha.example', ED_A)).toBe('match')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips an unreadable file and keeps the rest',
    async () => {
      const root = await createRoot()
      const unreadable = join(root, 'unreadable')
      const present = join(root, 'known_hosts')
      await writeFile(unreadable, hostLine('secret.example', ED_B))
      await chmod(unreadable, 0o000)
      await writeFile(present, hostLine('alpha.example', ED_A))

      const entries = await loadKnownHostsEntries([unreadable, present])

      expect(verdict(entries, 'alpha.example', ED_A)).toBe('match')
      expect(verdict(entries, 'secret.example', ED_B)).toBe('unknown')
    }
  )

  it('returns nothing when no file can be read', async () => {
    const root = await createRoot()

    await expect(loadKnownHostsEntries([join(root, 'absent')])).resolves.toEqual([])
  })
})

// The caller turns this count into a refusal, so the line between the two cases is the line between
// "every connection works" and "no connection works".
describe('loadKnownHostsEvidence', () => {
  // A profile that has never connected has no known_hosts — ssh writes one on its own first
  // connect. Counting that as a source we failed to read would refuse every first connection every
  // new user ever makes.
  it('does not count an absent file as unreadable', async () => {
    const root = await createRoot()

    const evidence = await loadKnownHostsEvidence([
      join(root, 'known_hosts'),
      join(root, 'known_hosts2')
    ])

    expect(evidence.unreadableFileCount).toBe(0)
    expect(evidence.entries).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'counts a file that exists but will not open',
    async () => {
      const root = await createRoot()
      const unreadable = join(root, 'known_hosts')
      await writeFile(unreadable, hostLine('secret.example', ED_B))
      await chmod(unreadable, 0o000)

      const evidence = await loadKnownHostsEvidence([unreadable])

      // The entry that would have said "this key changed" could be in here; we cannot tell.
      expect(evidence.unreadableFileCount).toBe(1)
    }
  )

  it('counts a path that is a directory', async () => {
    const root = await createRoot()
    await mkdir(join(root, 'a_directory'))

    const evidence = await loadKnownHostsEvidence([join(root, 'a_directory')])

    expect(evidence.unreadableFileCount).toBe(1)
  })

  it('reports nothing unreadable when every file parses', async () => {
    const root = await createRoot()
    const present = join(root, 'known_hosts')
    await writeFile(present, hostLine('alpha.example', ED_A))

    const evidence = await loadKnownHostsEvidence([present])

    expect(evidence.unreadableFileCount).toBe(0)
    expect(evidence.entries).toHaveLength(1)
  })

  // An empty file is a file we read successfully. Nothing is withheld, so nothing is suppressed.
  it('does not count an empty file as unreadable', async () => {
    const root = await createRoot()
    const empty = join(root, 'known_hosts')
    await writeFile(empty, '')

    const evidence = await loadKnownHostsEvidence([empty])

    expect(evidence.unreadableFileCount).toBe(0)
  })
})

describe('resolveKnownHostsLookupHost', () => {
  it('prefers HostKeyAlias over the resolved hostname', async () => {
    // A bastion tunnelled through localhost:2200 would otherwise mismatch on every target.
    const resolved = resolvedConfig({ hostname: '127.0.0.1', hostKeyAlias: 'bastion' })

    expect(resolveKnownHostsLookupHost(resolved, '127.0.0.1').host).toBe('bastion')
  })

  // INVERTED from 'uses the resolved hostname, never the Orca label'. That test encoded an
  // assumption verified false against OpenSSH 10.2p1: `ssh -G` echoes its own argument back as
  // `hostname` when no Host block matches, so for a manual target `resolved.hostname` IS the Orca
  // label — the one name the design forbids keying on, and one `ssh` never wrote. Keying on it
  // consults no entries at all, so an impersonated host reads as first contact.
  //
  // The dialed host is correct in both cases: buildConnectConfig has already applied HostName
  // resolution, so a config alias dials the real host too.
  it('uses the dialed host, because a resolved hostname can just echo the label', async () => {
    const resolved = resolvedConfig({ hostname: 'my-orca-label' })

    expect(resolveKnownHostsLookupHost(resolved, '10.0.0.5').host).toBe('10.0.0.5')
  })

  it('still prefers an explicit HostKeyAlias over the dialed host', async () => {
    const resolved = resolvedConfig({ hostname: 'my-orca-label', hostKeyAlias: 'bastion' })

    expect(resolveKnownHostsLookupHost(resolved, '10.0.0.5').host).toBe('bastion')
  })

  it('falls back to the dialed host when nothing was resolved', async () => {
    expect(resolveKnownHostsLookupHost(null, 'direct.example').host).toBe('direct.example')
    expect(
      resolveKnownHostsLookupHost(resolvedConfig({ hostname: '' }), 'direct.example').host
    ).toBe('direct.example')
  })
})

/**
 * `ssh -G` prints UserKnownHostsFile unquoted and space-separated, even when the config quoted it —
 * verified against OpenSSH 10.2p1. So one path containing a space is indistinguishable from two
 * paths, and splitting it shreds `C:\\Users\\John Doe\\.ssh\\known_hosts` into fragments that resolve
 * to nothing. Every fragment then misses with ENOENT, which reads as "absent" rather than
 * "unreadable", so the user appears to know no hosts and a CHANGED key is accepted as first contact.
 */
describe('a known_hosts path containing a space', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca known hosts '))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is rejoined when the split fragments resolve to nothing', async () => {
    const spaced = join(dir, 'known_hosts')
    expect(spaced).toContain(' ')
    await writeFile(spaced, '', 'utf-8')

    // Exactly what parseKnownHostsFileList hands over for this value.
    const resolved = await resolveKnownHostsFiles({
      userKnownHostsFiles: spaced.split(' '),
      globalKnownHostsFiles: []
    } as never)

    expect(resolved).toEqual([spaced])
  })

  it('rejoins a spaced path sitting alongside an ordinary one', async () => {
    // The mixed case a whole-list check cannot handle: it sees the ordinary path exist and leaves
    // the spaced one in fragments, so the file the user actually verified hosts in is never read.
    const spaced = join(dir, 'known_hosts')
    const ordinary = join(dir, 'other')
    await writeFile(spaced, '', 'utf-8')
    await writeFile(ordinary, '', 'utf-8')

    const resolved = await resolveKnownHostsFiles({
      userKnownHostsFiles: [...spaced.split(' '), ordinary],
      globalKnownHostsFiles: []
    } as never)

    expect(resolved).toEqual([spaced, ordinary])
  })

  it('leaves a genuine multi-file list alone', async () => {
    // Any fragment existing means these really are separate paths, not one shredded one.
    const real = join(dir, 'first')
    await writeFile(real, '', 'utf-8')

    const resolved = await resolveKnownHostsFiles({
      userKnownHostsFiles: [real, '/tmp/orca-does-not-exist-known-hosts'],
      globalKnownHostsFiles: []
    } as never)

    expect(resolved).toEqual([real, '/tmp/orca-does-not-exist-known-hosts'])
  })

  it('leaves a single unresolvable path alone rather than inventing one', async () => {
    const resolved = await resolveKnownHostsFiles({
      userKnownHostsFiles: ['/tmp/orca-absent-known-hosts'],
      globalKnownHostsFiles: []
    } as never)

    expect(resolved).toEqual(['/tmp/orca-absent-known-hosts'])
  })
})

/**
 * Verbatim from a real Windows host — `C:\Windows\System32\OpenSSH\ssh.exe -G github.com`, OpenSSH
 * for Windows. Captured rather than constructed, because the two things that bite here could not be
 * inferred from the POSIX output: the `__PROGRAMDATA__` token arrives UNEXPANDED, and separators are
 * MIXED within one path.
 *
 * Pinning it as a literal is what makes this testable off Windows at all. The parsing and the rejoin
 * are pure string work, so the only thing a Windows runner would add is the platform's `path`
 * arithmetic — which is why this covers the input shape and does not pretend to cover more.
 */
const WINDOWS_SSH_G_OUTPUT = [
  'hostname github.com',
  'port 22',
  'hashknownhosts no',
  'stricthostkeychecking ask',
  'globalknownhostsfile __PROGRAMDATA__\\ssh/ssh_known_hosts __PROGRAMDATA__\\ssh/ssh_known_hosts2',
  'userknownhostsfile C:\\Users\\neil/.ssh/known_hosts C:\\Users\\neil/.ssh/known_hosts2'
].join('\n')

describe('parsing real ssh -G output from Windows OpenSSH', () => {
  it('expands the __PROGRAMDATA__ token rather than passing it through as a path', () => {
    // Left literal it misses with ENOENT, and an absent file is indistinguishable from "no host is
    // known there" — so a site-managed known_hosts is silently invisible, including one holding a
    // rotated key that should have produced a mismatch rather than a first-contact accept.
    const previous = process.env.ProgramData
    process.env.ProgramData = 'C:\\ProgramData'
    try {
      const resolved = parseSshGOutput(WINDOWS_SSH_G_OUTPUT)
      for (const path of resolved.globalKnownHostsFiles) {
        expect(path).not.toContain('__PROGRAMDATA__')
        expect(path).toContain('ProgramData')
      }
      expect(resolved.globalKnownHostsFiles).toHaveLength(2)
    } finally {
      if (previous === undefined) {
        delete process.env.ProgramData
      } else {
        process.env.ProgramData = previous
      }
    }
  })

  it('does not rewrite a path that merely BEGINS with the token characters', () => {
    // `startsWith` alone also matches `__PROGRAMDATA__evil/x`, rewriting a file the user never named
    // into a directory they did not choose. The token has to be the whole path or be followed by a
    // separator. Found by probing the expansion rather than by reading it.
    const previous = process.env.ProgramData
    process.env.ProgramData = 'C:\\ProgramData'
    try {
      const resolved = parseSshGOutput('userknownhostsfile __PROGRAMDATA__evil/known_hosts')
      expect(resolved.userKnownHostsFiles).toEqual(['__PROGRAMDATA__evil/known_hosts'])
    } finally {
      if (previous === undefined) {
        delete process.env.ProgramData
      } else {
        process.env.ProgramData = previous
      }
    }
  })

  it('keeps a drive-letter path with mixed separators intact', () => {
    // `C:\Users\neil/.ssh/known_hosts` is what it really prints. Node's fs accepts both separators
    // on Windows, so the requirement is that nothing here rewrites or truncates it.
    const resolved = parseSshGOutput(WINDOWS_SSH_G_OUTPUT)
    expect(resolved.userKnownHostsFiles).toEqual([
      'C:\\Users\\neil/.ssh/known_hosts',
      'C:\\Users\\neil/.ssh/known_hosts2'
    ])
  })

  it('splits a spaced Windows home into the fragments the rejoin has to put back', () => {
    // The security-critical shape, now confirmed against the real format: a spaced home prints
    // unquoted, so `C:\Users\John Doe/.ssh/known_hosts` arrives as two tokens. This pins what the
    // parser hands the rejoin; rejoinSpaceSplitPaths is covered against real spaced files above.
    const spaced = parseSshGOutput(
      'userknownhostsfile C:\\Users\\John Doe/.ssh/known_hosts C:\\Users\\John Doe/.ssh/known_hosts2'
    )
    expect(spaced.userKnownHostsFiles).toEqual([
      'C:\\Users\\John',
      'Doe/.ssh/known_hosts',
      'C:\\Users\\John',
      'Doe/.ssh/known_hosts2'
    ])
  })
})
