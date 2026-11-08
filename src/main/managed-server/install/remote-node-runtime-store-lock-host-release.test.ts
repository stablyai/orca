import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  RUNTIME_STORE_LOCK_NAME,
  RUNTIME_STORE_LOCK_OWNER_FILENAME,
  withRuntimeStoreLock
} from './remote-node-runtime-store-lock'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { tryCreateInstallLockCommand } from './remote-install-lock-commands'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { unusedSshConnection } from '../testing/managed-host-transport.test-fixture'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

const conn = unusedSshConnection()
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

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'runtime-store-lock-'))
  lock = join(store, RUNTIME_STORE_LOCK_NAME)
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => sh(command))
})
afterEach(() => {
  rmSync(store, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('runtime store lock released by the host', () => {
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
