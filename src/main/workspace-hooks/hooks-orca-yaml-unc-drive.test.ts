import type * as NodeFs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  ...fsMock
}))

import { hasHooksFile, hasUnrecognizedOrcaYamlKeys, loadHooks } from './hooks'

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const DRIVE_YAML = String.raw`C:\src\app\orca.yaml`
const originalPlatform = process.platform

describe('orca.yaml of a UNC drive-mount repo', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    // WSL 2.7 refuses Windows access to a drive mount over UNC (existsSync swallows it as false).
    fsMock.existsSync.mockImplementation((path: string) => path === DRIVE_YAML)
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (path !== DRIVE_YAML) {
        throw Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), {
          code: 'EPERM'
        })
      }
      return 'scripts:\n  setup: pnpm install\nfutureKey: 1\n'
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('reads the setup hooks through the drive path', () => {
    expect(hasHooksFile(UNC)).toBe(true)
    expect(loadHooks(UNC)?.scripts?.setup).toBe('pnpm install')
    expect(hasUnrecognizedOrcaYamlKeys(UNC)).toBe(true)
    expect(fsMock.readFileSync).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\\\\/),
      expect.anything()
    )
  })
})
