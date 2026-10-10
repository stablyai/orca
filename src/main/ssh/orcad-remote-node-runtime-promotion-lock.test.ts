import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import {
  ensureRemoteOrcadNodeRuntime,
  NODE_RUNTIME_PROMOTE_TIMEOUT_MS,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY
} from './orcad-remote-node-runtime'
import { RUNTIME_STORE_LOCK_NAME } from './remote-node-runtime-store-lock'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('./ssh-relay-install-transfers', () => ({ uploadRelayDirectory: vi.fn(async () => {}) }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call goes through the mocked execCommand.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
const store = '/home/u/.orca-remote/runtimes'
const lock = `${store}/${RUNTIME_STORE_LOCK_NAME}`
let local: string
let commands: string[]

beforeEach(() => {
  local = mkdtempSync(join(tmpdir(), 'runtime-promotion-'))
  writeFileSync(join(local, 'node.tar.gz'), 'archive')
  commands = []
  vi.mocked(execCommand).mockClear()
})
afterEach(() => {
  rmSync(local, { recursive: true, force: true })
})

function answer(probe: (count: number) => string): void {
  let probes = 0
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
    commands.push(command)
    if (command.includes(`mkdir '${lock}' 2>/dev/null`)) {
      return 'OK'
    }
    if (command.includes('tar -xzf')) {
      return REMOTE_NODE_RUNTIME_READY
    }
    if (command.includes(REMOTE_NODE_RUNTIME_MISSING)) {
      return probe(++probes)
    }
    return ''
  })
}

async function ensure(): Promise<void> {
  await ensureRemoteOrcadNodeRuntime({
    conn,
    host,
    slotDir: '/home/u/.orca-remote/relay-0.1.0+abc',
    target: 'linux-x64-glibc',
    archivePath: async () => join(local, 'node.tar.gz')
  })
}

const indexOf = (needle: string): number => commands.findIndex((c) => c.includes(needle))
const lastIndexOf = (needle: string): number => commands.findLastIndex((c) => c.includes(needle))

describe('ensureRemoteOrcadNodeRuntime promotion lock', () => {
  it('promotes between taking and releasing the store lock', async () => {
    answer(() => REMOTE_NODE_RUNTIME_MISSING)
    await ensure()
    const taken = indexOf(`mkdir '${lock}' 2>/dev/null`)
    const promoted = indexOf('tar -xzf')
    const released = lastIndexOf(`rm -rf '${lock}'`)
    expect(taken).toBeGreaterThan(-1)
    expect(promoted).toBeGreaterThan(taken)
    expect(released).toBeGreaterThan(promoted)
  })

  it('re-hashes and promotes in one host command that the host lock release covers', async () => {
    answer(() => REMOTE_NODE_RUNTIME_MISSING)
    await ensure()
    // Why one command: a re-hash the client stops waiting on must not orphan the lock (HH-3).
    const locked = commands.filter((c) => c.includes('sha256sum'))
    expect(locked).toHaveLength(2)
    const [, recheck] = locked
    expect(recheck.indexOf('sha256sum')).toBeLessThan(recheck.indexOf('tar -xzf'))
    expect(recheck.lastIndexOf(`rm -rf '${lock}'`)).toBeGreaterThan(recheck.indexOf('tar -xzf'))
  })

  it('gives every full hash and the promote the slow-storage bound, not the 30 s exec default', async () => {
    answer(() => REMOTE_NODE_RUNTIME_MISSING)
    await ensure()
    const calls = vi
      .mocked(execCommand)
      .mock.calls.filter(([, command]) => command.includes('sha256sum'))
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call[2]).toMatchObject({ timeoutMs: NODE_RUNTIME_PROMOTE_TIMEOUT_MS })
    }
    expect(NODE_RUNTIME_PROMOTE_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('leaves the lock to the host release when promotion ends in an unconfirmed termination', async () => {
    answer(() => REMOTE_NODE_RUNTIME_MISSING)
    const lost = Object.assign(new Error('lost'), { sshChannelCloseConfirmed: false })
    const base = vi.mocked(execCommand).getMockImplementation()
    vi.mocked(execCommand).mockImplementation(async (c, command, options) => {
      if (command.includes('tar -xzf')) {
        commands.push(command)
        throw lost
      }
      return base!(c, command, options)
    })
    await expect(ensure()).rejects.toBe(lost)
    // The promote itself frees the lock on the host when its work exits; the client sends no release.
    const releases = commands.filter((c) => c.includes(`rm -rf '${lock}'`))
    expect(releases).toHaveLength(1)
    expect(releases[0]).toContain('tar -xzf')
    expect(releases[0].indexOf(`rm -rf '${lock}'`)).toBeGreaterThan(releases[0].indexOf('tar -xzf'))
  })
})
