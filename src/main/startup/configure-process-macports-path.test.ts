import type * as NodeFs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSystemCliInstallDirectories } from '../../shared/system-cli-install-dirs'
import { patchPackagedProcessPath } from './configure-process'

const fsFixture = vi.hoisted(() => ({ macPortsInstalled: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: (path: string) =>
      path === '/opt/local/bin/port' ? fsFixture.macPortsInstalled : actual.existsSync(path)
  }
})

vi.mock('electron', () => ({ app: { isPackaged: true } }))

describe('patchPackagedProcessPath MacPorts seed', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  function seedDarwinPath(): string[] {
    vi.stubEnv('HOME', '/Users/tester')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    patchPackagedProcessPath()
    return (process.env.PATH ?? '').split(':')
  }

  afterEach(() => {
    fsFixture.macPortsInstalled = false
    vi.unstubAllEnvs()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('seeds /opt/local last only when default-prefix port exists', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const withoutMacPorts = seedDarwinPath()
    expect(withoutMacPorts).not.toContain('/opt/local/bin')

    fsFixture.macPortsInstalled = true
    const segments = seedDarwinPath()
    // Appending only, so no existing binary resolves differently once MacPorts is installed.
    expect(segments).toEqual([...withoutMacPorts, '/opt/local/bin', '/opt/local/sbin'])
    // Lookup fallback must resolve a CLI in two system dirs the same way the seeded PATH does.
    const offsets = getSystemCliInstallDirectories('darwin', '/Users/tester').map((directory) =>
      segments.indexOf(directory)
    )
    expect(offsets.every((offset) => offset >= 0)).toBe(true)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
  })
})
