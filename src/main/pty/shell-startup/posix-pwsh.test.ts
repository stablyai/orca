import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type * as os from 'node:os'

const { executables } = vi.hoisted(() => ({ executables: new Set<string>() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    accessSync: (path: string) => {
      if (!executables.has(path)) {
        throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' })
      }
    },
    statSync: () => ({ isFile: () => true })
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: () => '/Users/jin'
}))

import { resolvePosixPaneShellPath } from './posix-pwsh'

const FINDER_LAUNCH_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('resolvePosixPaneShellPath', () => {
  let originalPlatform: PropertyDescriptor | undefined

  function onPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    executables.clear()
    onPlatform('darwin')
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('takes pwsh from the spawn PATH in execvp order', () => {
    executables.add('/custom/bin/pwsh').add('/opt/homebrew/bin/pwsh')

    expect(resolvePosixPaneShellPath('pwsh', '/usr/bin:/custom/bin')).toBe('/custom/bin/pwsh')
  })

  it.each(['tools:/custom/bin', ':/custom/bin', '/usr/bin::/custom/bin'])(
    'leaves the lookup to execvp at a cwd-relative PATH entry in %s',
    (spawnPath) => {
      executables.add('/custom/bin/pwsh').add('/opt/homebrew/bin/pwsh')

      expect(resolvePosixPaneShellPath('pwsh', spawnPath)).toBe('pwsh')
    }
  )

  it.each([
    ['Homebrew on Apple silicon', '/opt/homebrew/bin/pwsh'],
    ['Homebrew on Intel or the Microsoft .pkg link', '/usr/local/bin/pwsh'],
    ['the Microsoft .pkg payload', '/usr/local/microsoft/powershell/7/pwsh'],
    ['MacPorts', '/opt/local/bin/pwsh'],
    ['a dotnet global tool', '/Users/jin/.dotnet/tools/pwsh']
  ])('finds pwsh from %s when a Finder launch PATH lacks it', (_source, installed) => {
    executables.add(installed)

    expect(resolvePosixPaneShellPath('pwsh', FINDER_LAUNCH_PATH)).toBe(installed)
  })

  it('prefers Homebrew when both Homebrew and the .pkg payload exist', () => {
    executables.add('/usr/local/microsoft/powershell/7/pwsh').add('/opt/homebrew/bin/pwsh')

    expect(resolvePosixPaneShellPath('pwsh', FINDER_LAUNCH_PATH)).toBe('/opt/homebrew/bin/pwsh')
  })

  it.each(['/opt/microsoft/powershell/7/pwsh', '/snap/bin/pwsh', '/Users/jin/.linuxbrew/bin/pwsh'])(
    'finds %s on Linux',
    (installed) => {
      onPlatform('linux')
      executables.add(installed)

      expect(resolvePosixPaneShellPath('pwsh', '/bin')).toBe(installed)
    }
  )

  it.each([
    ['darwin', '/opt/homebrew/bin/pwsh-preview'],
    ['darwin', '/usr/local/microsoft/powershell/7-preview/pwsh'],
    ['linux', '/opt/microsoft/powershell/7-preview/pwsh'],
    ['linux', '/snap/bin/pwsh-preview']
  ] as const)('finds pwsh-preview on %s at %s', (platform, installed) => {
    onPlatform(platform)
    executables.add('/opt/homebrew/bin/pwsh').add('/usr/bin/pwsh').add(installed)

    expect(resolvePosixPaneShellPath('pwsh-preview', '/bin')).toBe(installed)
  })

  it('keeps the bare name for the spawn fallback when no install exists', () => {
    expect(resolvePosixPaneShellPath('pwsh', FINDER_LAUNCH_PATH)).toBe('pwsh')
  })

  it('leaves other shells, explicit paths and Windows untouched', () => {
    executables.add('/opt/homebrew/bin/pwsh').add('/usr/bin/fish')

    expect(resolvePosixPaneShellPath('fish', '/usr/bin')).toBe('fish')
    expect(resolvePosixPaneShellPath('/usr/local/bin/pwsh', '/opt/homebrew/bin')).toBe(
      '/usr/local/bin/pwsh'
    )
    onPlatform('win32')
    expect(resolvePosixPaneShellPath('pwsh', '/opt/homebrew/bin')).toBe('pwsh')
  })
})
