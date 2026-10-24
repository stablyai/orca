import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type { OrcadMachineHomeProbe } from './orcad-machine-home'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Local shell commands run with per-machine hostname and hardware identity shims.
const shell = vi.hoisted((): { env: NodeJS.ProcessEnv | undefined } => ({
  env: undefined
}))
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => {
  const { runProcess } = await import('@orca/process-host')
  return {
    ...(await importOriginal<typeof ExecCommandModule>()),
    execCommand: async (conn: { env?: NodeJS.ProcessEnv }, command: string) => {
      const env = conn.env ?? shell.env
      const merged = env?.ORCA_TEST_MERGE_STDERR === '1'
      const result = await runProcess({
        program: '/bin/sh',
        args: ['-c', merged ? `{ ${command}\n} 2>&1` : command],
        env
      })
      if (result.code !== 0) {
        const { sshCommandExitError } = await import('../../ssh/remote-exec/remote-exec-command')
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { resolveOrcadMachineHome } = await import('../install/orcad-remote-context')
const {
  decideOrcadMachineHome,
  orcadMachineIdentity,
  orcadMachineOwnershipUnresolvedMessage,
  parseOrcadMachineHomeProbe,
  ORCAD_MACHINE_CLAIM_FILENAME,
  ORCAD_MACHINE_HOMES_DIRNAME
} = await import('./orcad-machine-home')
const { ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME } = await import('./orcad-machine-claim-command')
const { computeRemoteInstallDir } = await import('../install/remote-versioned-install')
const { ORCAD_INSTALL_MODEL } = await import('../install/remote-install-model')
const { orcadLivenessProbeCommand } = await import('../install/orcad-remote-launch')
const { ORCAD_PID_FILENAME } = await import('../install/orcad-remote-host-support')
const { execOrcadRemote } = await import('../install/orcad-remote-runtime-control')
const { getRemoteHostPlatform } = await import('../../ssh/ssh-remote-platform')
type Probe = OrcadMachineHomeProbe
type Host = RemoteHostPlatform

const linux = getRemoteHostPlatform('linux-x64')
const darwin = getRemoteHostPlatform('darwin-arm64')
const POSIX = process.platform !== 'win32'

let scratch: string
let home: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orcad-machine-home-'))
  home = join(scratch, 'shared-home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function uuidOf(name: string): string {
  const hex = Buffer.from(name.padEnd(16, '-')).toString('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function ioregOutput(name: string): string {
  return `+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "${uuidOf(name).toUpperCase()}"\n`
}

type MachineOptions = {
  noHardLinks?: boolean
  /** Barrier both claim writers, then delay this machine's publication. */
  claimWriteDelay?: number
  /** Simulated df source distinguishes shared exports from local disks. */
  homeSource?: string
  availableKb?: number
  claimMoveError?: string
  /** Simulate stderr merged into stdout by an SSH gateway. */
  catStderrNoise?: string
}

/** Model macOS machines sharing one NFS home. */
function machine(name: string, hostname = name, options: MachineOptions = {}) {
  const bin = join(scratch, `bin-${name}-${hostname}`)
  mkdirSync(bin, { recursive: true })
  const tool = (tool: string, script: string): void => {
    writeFileSync(join(bin, tool), `#!/bin/sh\n${script}\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  tool('uname', `echo ${hostname}`)
  tool('ioreg', `printf '%s' '${ioregOutput(name)}'`)
  // macOS has no kern.hostuuid OID; probe must use ioreg.
  tool('sysctl', `echo "sysctl: unknown oid '$2'" >&2; exit 1`)
  if (options.homeSource !== undefined || options.availableKb !== undefined) {
    tool(
      'df',
      `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n%s 100 1 ${options.availableKb ?? 99} 1%% /home\\n' '${options.homeSource ?? '/dev/disk3s5'}'`
    )
  }
  if (options.claimMoveError !== undefined) {
    tool(
      'mv',
      [
        'for last; do :; done',
        `case "$last" in */${ORCAD_MACHINE_CLAIM_FILENAME}) echo "mv: ${options.claimMoveError}" >&2; exit 1;; esac`,
        'exec /bin/mv "$@"'
      ].join('\n')
    )
  }
  if (options.noHardLinks) {
    tool('ln', 'echo "ln: Operation not supported" >&2; exit 1')
  }
  if (options.claimWriteDelay !== undefined) {
    const barrier = join(scratch, 'claim-write-barrier')
    mkdirSync(barrier, { recursive: true })
    tool(
      'mv',
      [
        'for last; do :; done',
        `case "$last" in */${ORCAD_MACHINE_CLAIM_FILENAME})`,
        `  : > '${barrier}/'$$; i=0`,
        `  while [ "$(ls '${barrier}' | wc -l)" -lt 2 ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i + 1)); done`,
        `  sleep ${options.claimWriteDelay};;`,
        'esac',
        'exec /bin/mv "$@"'
      ].join('\n')
    )
  }
  if (options.catStderrNoise !== undefined) {
    // Inject noise around the claim, which ends without a newline.
    tool(
      'cat',
      `echo '${options.catStderrNoise}' >&2; /bin/cat "$@"; s=$?; printf '%s' '${options.catStderrNoise}' >&2; exit $s`
    )
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ORCA_TEST_MERGE_STDERR: options.catStderrNoise === undefined ? '0' : '1'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked execCommand reads only env.
  const conn = {
    env
  } as unknown as OrcadHostTransport
  return { conn, host: darwin, env }
}

function loginHomeResult() {
  return { loginHome: home, orcadHome: home, userDataDir: join(home, '.orca') }
}

function claimPath(): string {
  return join(home, '.orca-remote', ORCAD_MACHINE_CLAIM_FILENAME)
}

function legacyOwner(name: string, machineIdentity: string | null = uuidOf(name)): void {
  const dir = join(home, '.orca', '.profile-state-access', 'participants', 'token')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'token.owner'),
    JSON.stringify({
      token: 'token',
      pid: 4242,
      host: name,
      platform: 'darwin',
      ...(machineIdentity === null ? {} : { machineIdentity })
    })
  )
}

describe.runIf(POSIX)('resolveOrcadMachineHome on a home several machines share', () => {
  it('gives the first machine the login home and every other machine its own', async () => {
    const a = machine('node-a')
    const b = machine('node-b')

    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    const bHome = await resolveOrcadMachineHome(b, true)
    expect(bHome.loginHome).toBe(home)
    expect(bHome.orcadHome).toMatch(
      new RegExp(`^${home}/\\.orca-remote/${ORCAD_MACHINE_HOMES_DIRNAME}/[a-f0-9]{16}$`)
    )
    expect(statSync(bHome.orcadHome).mode & 0o777).toBe(0o700)
    // A shallow sibling path keeps runtime sockets within Unix length limits.
    expect(bHome.userDataDir).toMatch(new RegExp(`^${home}/\\.orca-[a-f0-9]{8}$`))

    expect(await resolveOrcadMachineHome(b, true)).toEqual(bHome)
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    expect(
      computeRemoteInstallDir(ORCAD_INSTALL_MODEL, bHome.orcadHome, '0.1.0+abc').startsWith(
        `${bHome.orcadHome}/.orca-remote/`
      )
    ).toBe(true)
  })

  it('never judges another machine’s PID: the second machine probes only its own slot', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    await resolveOrcadMachineHome(a, true)
    // Node-a's PID is not evidence about a process on node-b.
    const aSlot = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, home, '0.1.0+abc')
    mkdirSync(aSlot, { recursive: true })
    writeFileSync(join(aSlot, ORCAD_PID_FILENAME), '999999\n')

    const { orcadHome } = await resolveOrcadMachineHome(b, true)
    const bSlot = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, orcadHome, '0.1.0+abc')
    expect(bSlot).not.toBe(aSlot)
    const answer = await execOrcadRemote(b, orcadLivenessProbeCommand(darwin, bSlot))
    expect(answer.trim()).toBe('NEVER_LAUNCHED')
    expect(readFileSync(join(aSlot, ORCAD_PID_FILENAME), 'utf8')).toBe('999999\n')
  })

  it('upgrades an existing single-machine install in place', async () => {
    const a = machine('node-a')
    mkdirSync(join(home, '.orca-remote', 'orcad-0.1.0+abc'), {
      recursive: true
    })
    writeFileSync(join(home, '.orca-remote', 'orcad-active.json'), '{"schemaVersion":1}')
    mkdirSync(join(home, '.orca', 'profiles'), { recursive: true })
    legacyOwner('node-a')

    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    expect(existsSync(claimPath())).toBe(true)
    expect(readFileSync(join(home, '.orca-remote', 'orcad-active.json'), 'utf8')).toBe(
      '{"schemaVersion":1}'
    )
    expect(existsSync(join(home, '.orca-remote', ORCAD_MACHINE_HOMES_DIRNAME))).toBe(false)
  })

  it('leaves an unclaimed install to the machine whose orcad holds its data root', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    legacyOwner('node-a')

    const bHome = await resolveOrcadMachineHome(b, true)
    expect(bHome.orcadHome).not.toBe(home)
    expect(existsSync(claimPath())).toBe(false)

    // Node-a exits; node-b must retain its own home instead of adopting that install.
    rmSync(join(home, '.orca'), { recursive: true })
    expect(await resolveOrcadMachineHome(b, true)).toEqual(bHome)
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('lets exactly one of two machines claiming at once win', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    const homes = await Promise.all([
      resolveOrcadMachineHome(a, true),
      resolveOrcadMachineHome(b, true)
    ])
    expect(homes.filter((resolved) => resolved.orcadHome === home)).toHaveLength(1)
    expect(readdirNames(join(home, '.orca-remote'))).toEqual(
      [ORCAD_MACHINE_CLAIM_FILENAME, ORCAD_MACHINE_HOMES_DIRNAME].sort()
    )
  })

  it('keeps a Mac whose orcad predates macOS machine identity on its running install', async () => {
    const a = machine('node-a')
    mkdirSync(join(home, '.orca-remote', 'orcad-0.1.0+abc'), { recursive: true })
    // Legacy macOS ownership may omit machine identity.
    legacyOwner('node-a', null)
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('never lets another Mac claim a live install whose owner recorded no machine identity', async () => {
    const nfs = { homeSource: 'filer:/export/home' }
    const b = machine('node-b', 'node-b', nfs)
    mkdirSync(join(home, '.orca-remote', 'orcad-0.1.0+abc'), { recursive: true })
    writeFileSync(join(home, '.orca-remote', 'orcad-active.json'), '{"schemaVersion":1}')
    // Legacy owner proves hostname only, not machine UUID.
    legacyOwner('node-a', null)

    await expect(resolveOrcadMachineHome(b, true)).rejects.toThrow(
      /recorded only a hostname[\s\S]*If node-b set it up/
    )
    expect(existsSync(claimPath())).toBe(false)
    // macOS hostname drift cannot establish that a legacy owner belongs to this machine.
    await expect(
      resolveOrcadMachineHome(machine('node-a', 'cafe-wifi', nfs), true)
    ).rejects.toThrow(/recorded only a hostname/)
    expect(await resolveOrcadMachineHome(machine('node-a', 'node-a', nfs), true)).toEqual(
      loginHomeResult()
    )
  })

  it('lets exactly one machine claim a home on a filesystem without hard links', async () => {
    const a = machine('node-a', 'node-a', { noHardLinks: true, claimWriteDelay: 0 })
    const b = machine('node-b', 'node-b', { noHardLinks: true, claimWriteDelay: 0.5 })
    const homes = await Promise.all([
      resolveOrcadMachineHome(a, true),
      resolveOrcadMachineHome(b, true)
    ])
    expect(homes.filter((resolved) => resolved.orcadHome === home)).toHaveLength(1)
    expect(readdirNames(join(home, '.orca-remote'))).toEqual(
      [
        ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME,
        ORCAD_MACHINE_CLAIM_FILENAME,
        ORCAD_MACHINE_HOMES_DIRNAME
      ].sort()
    )
    expect(readdirNames(join(home, '.orca-remote', ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME))).toEqual([
      ORCAD_MACHINE_CLAIM_FILENAME
    ])
    expect(
      await Promise.all([resolveOrcadMachineHome(a, true), resolveOrcadMachineHome(b, true)])
    ).toEqual(homes)
  })

  it('lets exactly one of two machines replace an empty claim', async () => {
    mkdirSync(join(home, '.orca-remote'))
    writeFileSync(claimPath(), '')
    const homes = await Promise.all([
      resolveOrcadMachineHome(machine('node-a', 'node-a', { claimWriteDelay: 0 }), true),
      resolveOrcadMachineHome(machine('node-b', 'node-b', { claimWriteDelay: 0.5 }), true)
    ])
    expect(homes.filter((resolved) => resolved.orcadHome === home)).toHaveLength(1)
  })

  it('restores an emptied claim to the machine the arbiter already chose', async () => {
    const a = machine('node-a', 'node-a', { noHardLinks: true })
    const b = machine('node-b', 'node-b', { noHardLinks: true })
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    writeFileSync(claimPath(), '')
    expect((await resolveOrcadMachineHome(b, true)).orcadHome).not.toBe(home)
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('keeps a renamed machine on its own install', async () => {
    expect(await resolveOrcadMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(await resolveOrcadMachineHome(machine('node-a', 'renamed'), true)).toEqual(
      loginHomeResult()
    )
  })

  it('replaces an empty claim a full disk left behind', async () => {
    mkdirSync(join(home, '.orca-remote'))
    writeFileSync(claimPath(), '')
    expect(await resolveOrcadMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(readFileSync(claimPath(), 'utf8')).toContain('machineKey')
  })

  it.skipIf(process.getuid?.() === 0)(
    'says why it could not write the claim, and leaves no partial behind (#30491)',
    async () => {
      const remote = mkdirp(home, '.orca-remote')
      chmodSync(remote, 0o500)
      try {
        await expect(resolveOrcadMachineHome(machine('node-a'), true)).rejects.toThrow(
          /^orcad could not claim this host's \.orca-remote: could not write a claim file in ~\/\.orca-remote: .*Permission denied.*belongs to this user and is writable/u
        )
        expect(readdirSync(remote)).toEqual([])
      } finally {
        chmodSync(remote, 0o700)
      }
    }
  )

  it('reads the claim through a gateway that merges shell noise into the answer (#30491)', async () => {
    const noisy = { catStderrNoise: 'bash: warning: setlocale: LC_ALL: cannot change locale' }
    expect(await resolveOrcadMachineHome(machine('node-a', 'node-a', noisy), true)).toEqual(
      loginHomeResult()
    )
    expect(
      (await resolveOrcadMachineHome(machine('node-b', 'node-b', noisy), true)).orcadHome
    ).not.toBe(home)
  })

  it('names a full disk when the claim cannot be moved into place (#30491)', async () => {
    const full = { noHardLinks: true, availableKb: 0, claimMoveError: 'No space left on device' }
    await expect(resolveOrcadMachineHome(machine('node-a', 'node-a', full), true)).rejects.toThrow(
      /could not move the claim into place at ~\/\.orca-remote\/orcad-machine\.json: mv: No space left on device\. The filesystem holding ~\/\.orca-remote has 0 KB free/u
    )
    expect(existsSync(claimPath())).toBe(false)
    expect(await resolveOrcadMachineHome(machine('node-a', 'node-a-freed'), true)).toEqual(
      loginHomeResult()
    )
  })

  it('refuses to guess when the claim cannot be read', async () => {
    mkdirSync(join(home, '.orca-remote'))
    writeFileSync(claimPath(), 'not json')
    await expect(resolveOrcadMachineHome(machine('node-a'), true)).rejects.toThrow(
      /cannot tell which machine owns/
    )
  })

  it('names no owner for a stopped pre-claim install on a shared home until the user does', async () => {
    const nfs = { homeSource: 'filer:/export/home' }
    const a = machine('node-a', 'node-a', nfs)
    const b = machine('node-b', 'node-b', nfs)
    // Clean shutdown removed the data-root owner but left an unattributed prior activation.
    writeFileSync(join(mkdirp(home, '.orca-remote'), 'orcad-active.json'), '{"schemaVersion":1}')
    mkdirp(home, '.orca', '.profile-state-access', 'participants')

    await expect(resolveOrcadMachineHome(b, true)).rejects.toThrow(/can't tell which machine/)
    expect(existsSync(claimPath())).toBe(false)
    expect(existsSync(join(home, '.orca-remote', ORCAD_MACHINE_HOMES_DIRNAME))).toBe(false)

    const message = await resolveOrcadMachineHome(a, true).then(
      () => '',
      (error: unknown) => String(error)
    )
    expect(message).toContain('If node-a set it up')
    await execOrcadRemote(a, message.slice(message.indexOf('reconnect: ') + 'reconnect: '.length))
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
    expect((await resolveOrcadMachineHome(b, true)).orcadHome).not.toBe(home)
  })

  it('claims a shared home whose data root no orcad ever activated, and its fix runs anywhere', async () => {
    const a = machine('node-a', 'node-a', { homeSource: 'filer:/export/home' })
    // Profile use by a CLI need not imply any managed server install.
    mkdirp(home, '.orca', '.profile-state-access', 'participants')
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())

    // Ownership repair must also work before ~/.orca-remote exists.
    rmSync(join(home, '.orca-remote'), { recursive: true })
    const fix = orcadMachineOwnershipUnresolvedMessage('a'.repeat(16), null)
    await execOrcadRemote(a, fix.slice(fix.indexOf('reconnect: ') + 'reconnect: '.length))
    expect(readFileSync(claimPath(), 'utf8')).toContain('a'.repeat(16))
  })

  it('claims a stopped pre-claim install on a local disk, which no other machine can share', async () => {
    const a = machine('node-a', 'node-a', { homeSource: '/dev/disk3s5' })
    writeFileSync(join(mkdirp(home, '.orca-remote'), 'orcad-active.json'), '{"schemaVersion":1}')
    expect(await resolveOrcadMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('keeps WSL on the login home without probing or claiming', async () => {
    expect(await resolveOrcadMachineHome(machine('node-a'), false)).toEqual(loginHomeResult())
    expect(existsSync(join(home, '.orca-remote'))).toBe(false)
  })
})

function mkdirp(...parts: string[]): string {
  const dir = join(...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort()
}

function probe(host: Host, overrides: Partial<Probe> = {}): Probe {
  return {
    loginHome: '/home/u',
    identity: orcadMachineIdentity(host, 'a'.repeat(32), 'node-a'),
    claim: { state: 'absent' },
    dataRootOwners: [],
    machineHomeKeys: [],
    loginHomeInstalled: false,
    homeOnLocalDisk: false,
    ...overrides
  }
}

describe('decideOrcadMachineHome', () => {
  it('keys Linux by machine-id alone, so a rename keeps the key', () => {
    const a = orcadMachineIdentity(linux, 'a'.repeat(32), 'node-a')
    expect(a?.key).toMatch(/^[a-f0-9]{16}$/)
    expect(orcadMachineIdentity(linux, 'a'.repeat(32), 'renamed')?.key).toBe(a?.key)
    expect(orcadMachineIdentity(linux, 'b'.repeat(32), 'node-a')?.key).not.toBe(a?.key)
    // Missing/invalid machine identity preserves the legacy login-home fallback.
    expect(orcadMachineIdentity(linux, '', 'node-a')).toBeNull()
    expect(orcadMachineIdentity(linux, '0'.repeat(32), 'node-a')).toBeNull()
  })

  it('keys macOS by hardware UUID alone, since its hostname follows the network', () => {
    const uuid = '12345678-1234-1234-1234-123456789ABC'
    const ioreg = `    "IOPlatformUUID" = "${uuid}"`
    expect(orcadMachineIdentity(darwin, ioreg, 'cafe-wifi')?.key).toBe(
      orcadMachineIdentity(darwin, ioreg, 'home-wifi')?.key
    )
    expect(orcadMachineIdentity(darwin, ioreg, 'cafe-wifi')?.machineIdentity).toBe(
      uuid.toLowerCase()
    )
    // Empty legacy macOS sysctl output is not machine identity.
    expect(orcadMachineIdentity(darwin, '', 'cafe-wifi')).toBeNull()
    const renamed = probe(darwin, {
      identity: orcadMachineIdentity(darwin, ioreg, 'cafe-wifi'),
      dataRootOwners: [{ host: 'home-wifi', machineIdentity: uuid.toLowerCase() }]
    })
    expect(decideOrcadMachineHome(renamed, darwin).kind).toBe('claim')
  })

  it('judges a data-root owner by machine-id, and by hostname only when it recorded none', () => {
    const other = probe(linux, {
      dataRootOwners: [{ host: 'node-a', machineIdentity: 'b'.repeat(32) }]
    })
    expect(decideOrcadMachineHome(other, linux).kind).toBe('machine-home')
    const renamed = probe(linux, {
      dataRootOwners: [{ host: 'old-name', machineIdentity: 'a'.repeat(32) }]
    })
    expect(decideOrcadMachineHome(renamed, linux).kind).toBe('claim')
    const unrecorded = probe(linux, {
      dataRootOwners: [{ host: 'node-b', machineIdentity: null }]
    })
    expect(decideOrcadMachineHome(unrecorded, linux).kind).toBe('machine-home')
  })

  it('claims no install whose owner names neither its machine nor a matching hostname', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const mac = orcadMachineIdentity(darwin, `"IOPlatformUUID" = "${uuid}"`, 'mac-b')
    const otherMac = { host: 'mac-a', machineIdentity: null }
    expect(
      decideOrcadMachineHome(probe(darwin, { identity: mac, dataRootOwners: [otherMac] }), darwin)
    ).toEqual({ kind: 'unresolved', machineKey: mac?.key, cause: 'unattributed-owner' })
    expect(
      decideOrcadMachineHome(
        probe(darwin, { identity: mac, dataRootOwners: [otherMac], homeOnLocalDisk: true }),
        darwin
      ).kind
    ).toBe('claim')
    const nameless = probe(linux, { dataRootOwners: [{ host: null, machineIdentity: null }] })
    expect(decideOrcadMachineHome(nameless, linux).kind).toBe('unresolved')
  })

  it('reads a Linux home’s filesystem type before its df source', () => {
    const output = (installed: string, type: string, source: string): string =>
      [
        '/home/u',
        'a'.repeat(32),
        'node-a',
        'ABSENT',
        '',
        '',
        installed,
        type,
        `${source} 100 1 99 1% /home`
      ].join('\n__ORCA_MACHINE_HOME_SECTION__\n')
    const decide = (installed: string, type: string, source: string) =>
      decideOrcadMachineHome(
        parseOrcadMachineHomeProbe(output(installed, type, source), linux),
        linux
      )
    expect(decide('INSTALLED', 'nfs', '/dev/sda1').kind).toBe('unresolved')
    expect(decide('INSTALLED', 'ext2/ext3', 'filer:/export').kind).toBe('claim')
    // Old BusyBox may omit filesystem type; only device sources prove a local disk.
    expect(decide('INSTALLED', '', '/dev/sda1').kind).toBe('claim')
    expect(decide('INSTALLED', '', 'filer:/export').kind).toBe('unresolved')
    // Unused login homes have no prior server owner to strand.
    expect(decide('', 'nfs', 'filer:/export').kind).toBe('claim')
  })

  it('claims a stopped install only with evidence of whose it is', () => {
    const stopped = { loginHomeInstalled: true }
    expect(decideOrcadMachineHome(probe(linux, stopped), linux).kind).toBe('unresolved')
    expect(
      decideOrcadMachineHome(probe(linux, { ...stopped, homeOnLocalDisk: true }), linux).kind
    ).toBe('claim')
    const ownRunning = probe(linux, {
      ...stopped,
      dataRootOwners: [{ host: 'node-a', machineIdentity: 'a'.repeat(32) }]
    })
    expect(decideOrcadMachineHome(ownRunning, linux).kind).toBe('claim')
  })

  it('keeps the login home when the machine cannot be identified', () => {
    expect(decideOrcadMachineHome(probe(linux, { identity: null }), linux)).toEqual({
      kind: 'login-home'
    })
  })
})
