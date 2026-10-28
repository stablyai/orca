import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { credential } from './native-account-test-fixtures'
import {
  readAntigravityMacOSCredential,
  writeAntigravityMacOSCredential
} from './native-macos-credentials'

const enabled =
  process.platform === 'darwin' && process.env.ORCA_REAL_AGY_NATIVE_BACKEND_TEST === '1'

describe.skipIf(!enabled)('isolated macOS native credential backend', () => {
  it('writes and reads two complete profiles in a disposable item without changing agy authority', async () => {
    const target = {
      service: `orca-antigravity-backend-test.${randomUUID()}`,
      account: 'task-only'
    }
    expect(target.service).not.toBe('gemini')
    expect(target.account).not.toBe('antigravity')
    expect(await readAntigravityMacOSCredential(target)).toBeNull()
    try {
      await writeAntigravityMacOSCredential(credential('synthetic-a'), target)
      expect((await readAntigravityMacOSCredential(target))?.contents).toBe(
        credential('synthetic-a')
      )
      await writeAntigravityMacOSCredential(credential('synthetic-b', 2), target)
      expect((await readAntigravityMacOSCredential(target))?.contents).toBe(
        credential('synthetic-b', 2)
      )
    } finally {
      const removed = await runProcess({
        program: '/usr/bin/security',
        args: ['delete-generic-password', '-s', target.service, '-a', target.account],
        timeoutMs: 3000
      })
      expect(removed.code).toBe(0)
    }
    expect(await readAntigravityMacOSCredential(target)).toBeNull()
  }, 30_000)
})
