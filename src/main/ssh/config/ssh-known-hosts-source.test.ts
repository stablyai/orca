import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSshGOutput, type SshResolvedConfig } from './ssh-g-config-resolution'
import { matchKnownHosts, readHostKeyType, type KnownHostsEntry } from './ssh-known-hosts'
import {
  defaultKnownHostsFiles,
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

    // Probe failure must retain default trust sources, not convert verified hosts into first contact.
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

// Captured OpenSSH10.2p1 ssh -F config -G probe output, retaining the actual multi-file and host-policy format.
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

  // Multiple trust paths arrive on one space-separated line.
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

  // Missing accept-new would silently revert to ask.
  it('reads StrictHostKeyChecking, including accept-new', async () => {
    expect(resolved.strictHostKeyChecking).toBe('accept-new')
  })

  // HostKeyAlias outranks dialed host for loopback bastions.
  it('reads HostKeyAlias and prefers it for the lookup', async () => {
    expect(resolved.hostKeyAlias).toBe('alias-host')
    expect(resolveKnownHostsLookupHost(resolved, '127.0.0.1').host).toBe('alias-host')
  })

  it('reads the non-default port', async () => {
    expect(resolved.port).toBe(2222)
  })

  // Measured OpenSSH10.2p1 never brackets aliases, even off-port; stale bracketed entries must not block bare lookup.
  it('reports that the lookup came from an alias, so the port is not appended', async () => {
    expect(resolveKnownHostsLookupHost(resolved, '127.0.0.1').isHostKeyAlias).toBe(true)
  })

  it('reports no alias when the dialed host is used', async () => {
    expect(resolveKnownHostsLookupHost(null, '127.0.0.1').isHostKeyAlias).toBe(false)
  })
})

// The caller runs `matchKnownHosts` once over the union, so a hit in any file wins.
const loadKnownHostsEntries = async (files: readonly string[]): Promise<KnownHostsEntry[]> =>
  (await loadKnownHostsEvidence(files)).entries

describe('the union of known_hosts entries', () => {
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

// Distinguish normal absence from withheld evidence in an existing unreadable source.
describe('loadKnownHostsEvidence', () => {
  // A new profile has no known_hosts yet; absence is not unreadable evidence.
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

  // ssh -G can echo a manual label as hostname; use the dialed host so existing trust cannot be missed.
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

/** OpenSSH10.2p1 prints spaced trust paths unquoted; splitting can hide existing changed-key evidence as absent files. */
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

    const resolved = await resolveKnownHostsFiles({
      userKnownHostsFiles: spaced.split(' '),
      globalKnownHostsFiles: []
    } as never)

    expect(resolved).toEqual([spaced])
  })

  it('rejoins a spaced path sitting alongside an ordinary one', async () => {
    // Rejoin spaced paths even beside an existing ordinary file.
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

/** Captured Windows OpenSSH output preserves unexpanded __PROGRAMDATA__ and mixed separators; these tests cover parsing, not Windows filesystem arithmetic. */
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
    // Literal __PROGRAMDATA__ hides system trust as absent, potentially missing changed keys.
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
    // Require a token boundary so __PROGRAMDATA__evil is never rewritten.
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
    // Preserve mixed Windows separators exactly; Node fs accepts them.
    const resolved = parseSshGOutput(WINDOWS_SSH_G_OUTPUT)
    expect(resolved.userKnownHostsFiles).toEqual([
      'C:\\Users\\neil/.ssh/known_hosts',
      'C:\\Users\\neil/.ssh/known_hosts2'
    ])
  })

  it('splits a spaced Windows home into the fragments the rejoin has to put back', () => {
    // Captured unquoted spaced homes arrive split; real-file rejoin coverage above proves recovery.
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
