import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import type { SshConnection } from './ssh-connection'
import {
  RUNTIME_STORE_LOCK_NAME,
  RUNTIME_STORE_LOCK_OWNER_FILENAME,
  withRuntimeStoreLock
} from './remote-node-runtime-store-lock'
import { execCommand } from './ssh-relay-deploy-helpers'
import { tryCreateInstallLockCommand } from './ssh-relay-install-lock-commands'
import { getRemoteHostPlatform } from './ssh-remote-platform'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call goes through the mocked execCommand, which runs it in a local shell.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
let store: string
let lock: string

async function sh(command: string): Promise<string> {
  const result = await runProcess({ program: '/bin/sh', args: ['-c', command], timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw Object.assign(new Error(`exit ${result.code}: ${result.stdout}${result.stderr}`), {
      exitCode: result.code,
      stdout: result.stdout
    })
  }
  return result.stdout
}

const unconfirmed = (): Error =>
  Object.assign(new Error('timed out after 30s'), {
    code: 'SSH_EXEC_TIMEOUT',
    sshChannelCloseConfirmed: false
  })

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'runtime-store-lock-'))
  lock = join(store, RUNTIME_STORE_LOCK_NAME)
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => sh(command))
})
afterEach(() => {
  rmSync(store, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('runtime store lock released by the host', () => {
  it('passes the wrapped command output and exit status through and frees the lock', async () => {
    await withRuntimeStoreLock(conn, host, store, async (held) => {
      expect(existsSync(lock)).toBe(true)
      expect((await sh(held.releasedByHostOnExit('echo ORCA_NODE_RUNTIME_READY'))).trim()).toBe(
        'ORCA_NODE_RUNTIME_READY'
      )
      expect(existsSync(lock)).toBe(false)
      await expect(sh(held.releasedByHostOnExit('echo partial; exit 3'))).rejects.toMatchObject({
        exitCode: 3,
        stdout: 'partial\n'
      })
    })
    expect(existsSync(lock)).toBe(false)
  })

  it('frees the lock when work the client gave up on finishes, so the next installer proceeds', async () => {
    let orphan: Promise<string> | undefined
    await expect(
      withRuntimeStoreLock(conn, host, store, async (held) => {
        // The client's exec timer fires while the host is still extracting (HH-3).
        orphan = sh(held.releasedByHostOnExit('sleep 1; echo ORCA_NODE_RUNTIME_READY'))
        throw unconfirmed()
      })
    ).rejects.toMatchObject({ sshChannelCloseConfirmed: false })
    // Kept while the work runs: loss of contact is not an exit.
    expect(existsSync(lock)).toBe(true)
    const started = Date.now()
    await withRuntimeStoreLock(conn, host, store, async () => {})
    // Without the host release this waits out the 20-minute stale rule.
    expect(Date.now() - started).toBeLessThan(10_000)
    await orphan
  }, 20_000)

  it('keeps releasing after the client side hangs up on the host shell', async () => {
    await expect(
      withRuntimeStoreLock(conn, host, store, async (held) => {
        const child = spawnProcess({
          program: '/bin/sh',
          args: ['-c', held.releasedByHostOnExit('sleep 1; echo done')],
          stdio: 'ignore'
        })
        await new Promise((resolve) => setTimeout(resolve, 200))
        child.kill('SIGHUP')
        throw unconfirmed()
      })
    ).rejects.toMatchObject({ sshChannelCloseConfirmed: false })
    expect(existsSync(lock)).toBe(true)
    await waitUntil(() => !existsSync(lock), 10_000)
  }, 20_000)

  it('never removes a lock another holder took after the host released this one', async () => {
    await withRuntimeStoreLock(conn, host, store, async (held) => {
      await sh(held.releasedByHostOnExit('true'))
      const created = await sh(
        tryCreateInstallLockCommand(host, lock, {
          fileName: RUNTIME_STORE_LOCK_OWNER_FILENAME,
          token: 'sibling'
        })
      )
      expect(created.trim()).toBe('OK')
    })
    expect(readFileSync(join(lock, RUNTIME_STORE_LOCK_OWNER_FILENAME), 'utf8')).toBe('sibling')
  })
})
