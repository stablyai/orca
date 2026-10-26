import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pinnedNodeRuntimeAsset } from '../../../shared/node-runtime-pin'
import { runProcess } from '@orca/process-host'
import {
  ensureRemoteOrcadNodeRuntime,
  posixNodeRuntimeExecutable,
  remoteNodeRuntimeDir
} from './orcad-remote-node-runtime'
import {
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER
} from '../../ssh/orcad-remote-node-runtime-report'
import { RUNTIME_STORE_LOCK_NAME, withRuntimeStoreLock } from './remote-node-runtime-store-lock'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { uploadRemoteInstallDirectory } from './remote-install-transfers'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedOrcadHostTransport } from '../../ssh/unused-host-transport.test-fixture'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./remote-install-transfers', () => ({ uploadRemoteInstallDirectory: vi.fn() }))

const conn = unusedOrcadHostTransport()
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
  // Slow storage lets executable hashing outlast client observation.
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
    // Model sibling publication during this installer's upload.
    vi.mocked(uploadRemoteInstallDirectory).mockImplementation(async () => {
      mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
      writeFileSync(posixNodeRuntimeExecutable(host, runtimeDir), 'node', { mode: 0o755 })
      writeFileSync(join(runtimeDir, REMOTE_NODE_RUNTIME_VERIFIED_MARKER), '')
    })
    let hashes = 0
    let orphan: Promise<string> | undefined
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('sha256sum') && ++hashes === 2) {
        // Stop client observation while the under-lock hash keeps executing on the host.
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
    // Lost contact cannot prove the hash exited; its runtime lock must remain held.
    expect(existsSync(join(store, RUNTIME_STORE_LOCK_NAME))).toBe(true)
    // Host-side release avoids waiting for the 20-minute stale-lock window.
    await withRuntimeStoreLock(conn, host, store, async () => {}, AbortSignal.timeout(10_000))
    expect((await orphan)?.trim()).toBe(REMOTE_NODE_RUNTIME_READY)
  }, 20_000)
})
