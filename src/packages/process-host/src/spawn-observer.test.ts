import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  E2E_SPAWN_LOG_ENV,
  E2E_USER_DATA_DIR_ENV,
  hasSpawnObserver,
  notifySpawnObserver,
  setSpawnObserver
} from './spawn-observer'

afterEach(() => {
  setSpawnObserver(null)
  vi.restoreAllMocks()
  delete process.env[E2E_SPAWN_LOG_ENV]
  delete process.env[E2E_USER_DATA_DIR_ENV]
})

describe('spawn observer', () => {
  it('outside e2e mode writes nothing and captures no stack, even with the log variable set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orca-spawn-log-'))
    const log = path.join(dir, 'spawns.jsonl')
    process.env[E2E_SPAWN_LOG_ENV] = log
    const errors = vi.spyOn(globalThis, 'Error')
    try {
      notifySpawnObserver(process.execPath, ['-e', 'process.exit(0)'], 0)
      expect(errors).not.toHaveBeenCalled()
      expect(existsSync(log)).toBe(false)
      expect(hasSpawnObserver()).toBe(false)

      // Control: the same call in e2e mode does capture the stack and write the line.
      process.env[E2E_USER_DATA_DIR_ENV] = dir
      notifySpawnObserver(process.execPath, ['-e', 'process.exit(0)'], 0)
      expect(errors).toHaveBeenCalledTimes(1)
      expect(existsSync(log)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
