import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pinnedNodeRuntimeAsset } from '../../shared/node-runtime-pin'
import { runProcess } from '../../shared/child-process/run-process'
import type { SshConnection } from './ssh-connection'
import {
  ensureRemoteOrcadNodeRuntime,
  posixNodeRuntimeExecutable,
  REMOTE_NODE_RUNTIME_READY,
  remoteNodeRuntimeDir
} from './orcad-remote-node-runtime'
import { REMOTE_NODE_RUNTIME_VERIFIED_MARKER } from './orcad-remote-node-runtime-report'
import { RUNTIME_STORE_LOCK_NAME, withRuntimeStoreLock } from './remote-node-runtime-store-lock'
import { execCommand } from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory } from './ssh-relay-install-transfers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('./ssh-relay-install-transfers', () => ({ uploadRelayDirectory: vi.fn() }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call goes through the mocked execCommand, which runs it in a local shell.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
const target = 'linux-x64-glibc'
let root: string
let shim: string

async function sh(command: string): Promise<string> {
  const result = await runProcess({
    program: '/bin/sh',
    args: ['-c', `PATH=${shim}:$PATH; ${command}`],
    timeoutMs: 30_000
  })
  if (result.code !== 0) {
    throw new Error(`exit ${result.code}: ${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-slow-hash-'))
  shim = join(root, 'shim')
  mkdirSync(shim)
  // Slow home storage: reading the executable takes longer than the client waits.
  writeFileSync(
    join(shim, 'sha256sum'),
    `#!/bin/sh\nsleep 1\necho "${pinnedNodeRuntimeAsset(target).executableSha256}  $1"\n`,
    { mode: 0o755 }
  )
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('runtime install on slow storage', () => {
  it('frees the store lock once a re-hash the client timed out on finishes', async () => {
    const slotDir = join(root, '.orca-remote', 'relay-0.1.0+abc')
    const runtimeDir = remoteNodeRuntimeDir(host, slotDir, target)
    const store = join(root, '.orca-remote', 'runtimes')
    const archive = join(root, 'node.tar.gz')
    writeFileSync(archive, 'archive')
    // A sibling installer publishes this pin while this client uploads.
    vi.mocked(uploadRelayDirectory).mockImplementation(async () => {
      mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
      writeFileSync(posixNodeRuntimeExecutable(host, runtimeDir), 'node', { mode: 0o755 })
      writeFileSync(join(runtimeDir, REMOTE_NODE_RUNTIME_VERIFIED_MARKER), '')
    })
    let hashes = 0
    let orphan: Promise<string> | undefined
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('sha256sum') && ++hashes === 2) {
        // The under-lock re-hash outlives the client's exec timer; the host keeps running it.
        orphan = sh(command)
        throw Object.assign(new Error('timed out'), {
          code: 'SSH_EXEC_TIMEOUT',
          sshChannelCloseConfirmed: false
        })
      }
      return sh(command)
    })
    await expect(
      ensureRemoteOrcadNodeRuntime({
        conn,
        host,
        slotDir,
        target,
        archivePath: async () => archive
      })
    ).rejects.toMatchObject({ sshChannelCloseConfirmed: false })
    expect(orphan).toBeDefined()
    // Kept while the hash runs: loss of contact is not an exit.
    expect(existsSync(join(store, RUNTIME_STORE_LOCK_NAME))).toBe(true)
    // Without the host release this waits out the 20-minute stale rule.
    await withRuntimeStoreLock(conn, host, store, async () => {}, AbortSignal.timeout(10_000))
    expect((await orphan)?.trim()).toBe(REMOTE_NODE_RUNTIME_READY)
  }, 20_000)
})
