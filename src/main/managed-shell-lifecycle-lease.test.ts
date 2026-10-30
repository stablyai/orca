import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  it.each([false, true])(
    'releases an unclaimed launch on early return/rejection (reject=%s)',
    async (reject) => {
      const path = createShellLifecycleStateFile()
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
    const path = createShellLifecycleStateFile()
    if (!path) {
      throw new Error('missing state file')
    }
    try {
      await withShellLifecycleStateFile({ [SHELL_LIFECYCLE_STATE_ENV]: path }, async () => {
        expect(claimShellLifecycleStateFile(path)).toBe(path)
      })
      expect(existsSync(path)).toBe(true)
      releaseShellLifecycleStateFile(path)
      expect(existsSync(dirname(path))).toBe(false)
    } finally {
      rmSync(dirname(path), { recursive: true, force: true })
    }
  })

  it('preserves an unregistered or replaced file', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-lifecycle-foreign-test-'))
    const foreign = join(root, 'foreign')
    const path = createShellLifecycleStateFile()
    if (!path) {
      throw new Error('missing state file')
    }
    try {
      writeFileSync(foreign, 'foreign')
      releaseShellLifecycleStateFile(foreign)
      expect(existsSync(foreign)).toBe(true)
      renameSync(foreign, path)
      releaseShellLifecycleStateFile(path)
      expect(existsSync(path)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(dirname(path), { recursive: true, force: true })
    }
  })
})
