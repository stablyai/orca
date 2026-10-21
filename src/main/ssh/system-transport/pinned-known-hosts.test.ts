import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { isHostKeyVerificationError } from '../ssh-host-key-decision'
import { pinnedKnownHostsArgs, writePinnedKnownHosts } from './pinned-known-hosts'
import { buildSshArgs } from './system-ssh-args'

const ED_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function machineTarget(owner: Partial<NonNullable<SshTarget['owner']>> = {}): SshTarget {
  return {
    id: 'machine-0123',
    label: 'omarchy-dev',
    host: '100.84.183.82',
    port: 42200,
    username: 'dev',
    jumpHost: 'neil@100.84.183.82',
    owner: {
      type: 'machine',
      runtimeId: 'machine-0123',
      providerKey: 'plugin:acme.omarchy/omarchy',
      machineId: 'sbx-1',
      hostKeys: [ED_KEY],
      ...owner
    }
  }
}

describe('provider-pinned system OpenSSH', () => {
  it('every system ssh invocation for a pinned machine accepts only the pinned file', () => {
    const args = buildSshArgs(machineTarget())
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain('HostKeyAlias=machine-0123')
    expect(args.some((arg) => arg.startsWith('UserKnownHostsFile="'))).toBe(true)
    expect(args.some((arg) => arg.startsWith('GlobalKnownHostsFile="'))).toBe(true)
    // Pin options come before `--`, so they apply to the destination host.
    expect(args.indexOf('StrictHostKeyChecking=yes')).toBeLessThan(args.indexOf('--'))
  })

  it('adds nothing for ordinary or recipe-VM targets', () => {
    const { owner: _owner, ...plain } = machineTarget()
    expect(pinnedKnownHostsArgs(plain, '/data/hosts.json')).toEqual([])
    expect(
      pinnedKnownHostsArgs(
        { ...plain, owner: { type: 'on-demand-runtime', runtimeId: 'vm-1' } },
        '/data/hosts.json'
      )
    ).toEqual([])
  })

  it('writes only the provider keys under the target alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-pinned-known-hosts-'))
    roots.push(root)
    const storeFile = join(root, 'ssh-host-keys.json')
    writePinnedKnownHosts(machineTarget(), storeFile)
    const file = join(root, 'pinned-known-hosts', 'machine-0123')
    expect(await readFile(file, 'utf8')).toBe(`machine-0123 ${ED_KEY}\n`)
    expect(pinnedKnownHostsArgs(machineTarget(), storeFile)).toContain(
      `UserKnownHostsFile="${file}"`
    )
  })

  it('refuses a fingerprint-only pin instead of trusting the user known_hosts', () => {
    const target = machineTarget({
      hostKeys: undefined,
      hostKeyFingerprints: [`SHA256:${'A'.repeat(43)}`]
    })
    let caught: unknown
    try {
      writePinnedKnownHosts(target, '/data/hosts.json')
    } catch (error) {
      caught = error
    }
    expect(isHostKeyVerificationError(caught)).toBe(true)
    // Even if a caller skipped the write, the args still name a file with no keys: fail closed.
    expect(buildSshArgs(target)).toContain('StrictHostKeyChecking=yes')
  })
})
