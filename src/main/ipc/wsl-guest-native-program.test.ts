import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetWindowsCopyVerdictsForTests,
  resolveGuestNativeProgram
} from './wsl-guest-windows-drive-path'

let root: string
let native: string
let drive: string

function install(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const program = join(dir, 'claude')
  writeFileSync(program, '#!/bin/sh\n')
  chmodSync(program, 0o755)
  return program
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-guest-native-'))
  native = join(root, 'home', '.local', 'bin')
  // Stands in for a Windows drive mount such as /mnt/c.
  drive = join(root, 'c')
})

afterEach(() => {
  vi.useRealTimers()
  _resetWindowsCopyVerdictsForTests()
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('resolveGuestNativeProgram', () => {
  const options = () => ({ pathEnv: `${native}:${drive}/npm`, homePath: join(root, 'home') })

  it('prefers the WSL install over a Windows copy later on PATH', () => {
    const own = install(native)
    install(join(drive, 'npm'))
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBe(own)
  })

  it('answers null when only a Windows copy exists, which a bare-name spawn would still reach', () => {
    install(join(drive, 'npm'))
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('the Windows-copy check', () => {
  const options = () => ({ pathEnv: `${native}:${drive}/npm`, homePath: join(root, 'home') })

  it('still finds a WSL install made after the verdict was cached', () => {
    install(join(drive, 'npm'))
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBeNull()
    const own = install(native)
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBe(own)
  })

  it('re-checks once the verdict is old', () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBe('claude')
    install(join(drive, 'npm'))
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBe('claude')
    vi.advanceTimersByTime(30_000)
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBeNull()
  })
})
