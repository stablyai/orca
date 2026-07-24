import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    once: vi.fn()
  }
}))

import { X_DISPLAY_LOCK_MAX_BYTES, readXDisplayLockPid } from './ensure-virtual-display'

const roots: string[] = []

function createLock(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-x-display-lock-'))
  roots.push(root)
  const lockPath = join(root, '.X99-lock')
  writeFileSync(lockPath, contents)
  return lockPath
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('X display lock reader', () => {
  it('accepts a PID marker at the exact byte boundary', () => {
    const pid = '4321'
    const lockPath = createLock(pid + ' '.repeat(X_DISPLAY_LOCK_MAX_BYTES - pid.length))

    expect(readXDisplayLockPid(lockPath)).toBe(4321)
  })

  it('rejects a sparse PID marker one byte over the boundary', () => {
    const lockPath = createLock('4321')
    truncateSync(lockPath, X_DISPLAY_LOCK_MAX_BYTES + 1)

    expect(readXDisplayLockPid(lockPath)).toBeNull()
  })
})
