import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  _resetWindowsCopyVerdictsForTests,
  guestNativeSpawnEnv,
  isWslHostOrcadProcess,
  ORCAD_WSL_HOST_ENV,
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

  it('leaves a program missing everywhere as its bare name, so the spawn fails as not installed', () => {
    expect(resolveGuestNativeProgram('claude', options(), undefined, [drive])).toBe('claude')
  })

  it('resolves exactly as before off a WSL host (native Linux, macOS, SSH hosts, the desktop)', () => {
    const windowsCopy = install(join(drive, 'npm'))
    expect(resolveGuestNativeProgram('claude', options(), undefined, [])).toBe(windowsCopy)
  })
})

describe.skipIf(process.platform === 'win32')('the Windows-copy check', () => {
  const options = () => ({ pathEnv: `${native}:${drive}/npm`, homePath: join(root, 'home') })
  const counting = () => vi.fn(resolveCliCommand)

  it('scans the drive-mounted PATH once for repeated lookups of the same PATH', () => {
    install(join(drive, 'npm'))
    const resolve = counting()
    expect(resolveGuestNativeProgram('claude', options(), resolve, [drive])).toBeNull()
    expect(resolveGuestNativeProgram('claude', options(), resolve, [drive])).toBeNull()
    // One native lookup per call, one Windows-copy scan in total.
    expect(resolve).toHaveBeenCalledTimes(3)
  })

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

  it('caches nothing off a WSL host (native Linux, macOS, SSH hosts, the desktop)', () => {
    const resolve = counting()
    expect(resolveGuestNativeProgram('claude', options(), resolve, [])).toBe('claude')
    const windowsCopy = install(join(drive, 'npm'))
    expect(resolveGuestNativeProgram('claude', options(), resolve, [])).toBe(windowsCopy)
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})

describe('guestNativeSpawnEnv', () => {
  it('drops Windows drive entries from a WSL-host agent child PATH', () => {
    expect(guestNativeSpawnEnv({ PATH: '/usr/bin:/mnt/c/npm', HOME: '/h' }, ['/mnt/c'])).toEqual({
      PATH: '/usr/bin',
      HOME: '/h'
    })
  })

  it('returns the env untouched where there are no drive mounts', () => {
    const env = { PATH: '/usr/bin:/mnt/c/npm' }
    expect(guestNativeSpawnEnv(env, [])).toBe(env)
  })
})

describe('the WSL-host gate', () => {
  const marked = { [ORCAD_WSL_HOST_ENV]: '1', WSL_DISTRO_NAME: 'Ubuntu' }

  it('stays off on macOS, the Windows desktop, native Linux and SSH-host orcad', () => {
    expect(isWslHostOrcadProcess(marked, 'darwin', () => true)).toBe(false)
    expect(isWslHostOrcadProcess(marked, 'win32', () => true)).toBe(false)
    expect(isWslHostOrcadProcess({}, 'linux', () => false)).toBe(false)
    // An SSH host's orcad is launched with nohup and never gets the WSL-host marker.
    expect(isWslHostOrcadProcess({ ORCA_USER_DATA: '/srv/orca' }, 'linux', () => false)).toBe(false)
  })

  it('turns on only for orcad launched as a WSL host inside the guest', () => {
    expect(isWslHostOrcadProcess(marked, 'linux', () => false)).toBe(true)
  })
})
