import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { SHELL_LIFECYCLE_BINDING_ENV } from './managed-shell-lifecycle'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  SHELL_LIFECYCLE_STATE_ENV,
  createShellLifecycleStateFile,
  claimShellLifecycleStateFile,
  releaseShellLifecycleStateFile,
  withShellLifecycleStateFile
} from './managed-shell-lifecycle-state-file'

describe('private lifecycle state ownership', () => {
  it('prepares a private state file before a bound launch and cleans up a rejected launch', async () => {
    const env: Record<string, string> = { [SHELL_LIFECYCLE_BINDING_ENV]: 'bound-launch' }
    let statePath: string | undefined
    await expect(
      withShellLifecycleStateFile(env, async () => {
        statePath = env[SHELL_LIFECYCLE_STATE_ENV]
        if (!statePath) {
          throw new Error('missing state file before launch')
        }
        expect(existsSync(statePath)).toBe(true)
        if (process.platform !== 'win32') {
          expect(statSync(statePath).mode & 0o777).toBe(0o600)
          expect(statSync(dirname(statePath)).mode & 0o777).toBe(0o700)
        }
        throw new Error('cancelled before spawn')
      })
    ).rejects.toThrow('cancelled before spawn')
    if (!statePath) {
      throw new Error('missing state file before launch')
    }
    expect(existsSync(dirname(statePath))).toBe(false)
  })

  it.each([false, true])(
    'releases an unclaimed launch on early return/rejection (reject=%s)',
    async (reject) => {
      const path = await createShellLifecycleStateFile()
      expect(path).toEqual(expect.any(String))
      if (!path) {
        throw new Error('missing state file')
      }
      try {
        const result = withShellLifecycleStateFile(
          { [SHELL_LIFECYCLE_STATE_ENV]: path },
          async () => {
            if (reject) {
              throw new Error('cancelled before spawn')
            }
            return 'concurrent-winner'
          }
        )
        if (reject) {
          await expect(result).rejects.toThrow('cancelled before spawn')
        } else {
          expect(await result).toBe('concurrent-winner')
        }
        expect(existsSync(dirname(path))).toBe(false)
      } finally {
        rmSync(dirname(path), { recursive: true, force: true })
      }
    }
  )

  it('retains an adopted launch until its physical-exit owner releases it', async () => {
    const path = await createShellLifecycleStateFile()
    if (!path) {
      throw new Error('missing state file')
    }
    try {
      await withShellLifecycleStateFile({ [SHELL_LIFECYCLE_STATE_ENV]: path }, async () => {
        expect(claimShellLifecycleStateFile(path)).toBe(path)
      })
      expect(existsSync(path)).toBe(true)
      await releaseShellLifecycleStateFile(path)
      expect(existsSync(dirname(path))).toBe(false)
    } finally {
      rmSync(dirname(path), { recursive: true, force: true })
    }
  })

  it('preserves an unregistered or replaced file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-lifecycle-foreign-test-'))
    const foreign = join(root, 'foreign')
    const path = await createShellLifecycleStateFile()
    if (!path) {
      throw new Error('missing state file')
    }
    try {
      writeFileSync(foreign, 'foreign')
      await releaseShellLifecycleStateFile(foreign)
      expect(existsSync(foreign)).toBe(true)
      renameSync(foreign, path)
      await releaseShellLifecycleStateFile(path)
      expect(existsSync(path)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(dirname(path), { recursive: true, force: true })
    }
  })
})
