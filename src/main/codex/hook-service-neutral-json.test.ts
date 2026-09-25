import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return {
    app: {
      getPath: () => join(tmpdir(), 'orca-user-data')
    }
  }
})

import { getCodexManagedHookInstallMaterial } from './hook-service'

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function scriptForPlatform(platform: 'darwin' | 'win32'): string {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return getCodexManagedHookInstallMaterial().script
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
})

// Why: Codex fails every SessionStart/Stop hook whose stdout is not valid JSON (#16356), the same
// fail-closed contract Claude's hook already answers with neutral JSON (#14818).
describe('managed Codex hook script neutral JSON', () => {
  it('emits neutral JSON before anything can exit early, on POSIX', () => {
    const script = scriptForPlatform('darwin')

    expect(script.indexOf('printf "{}\\n"')).toBe(
      script.indexOf('#!/bin/sh') + '#!/bin/sh\n'.length
    )
    // Why: the guards below return 0 without posting, so a later printf would never run.
    expect(script.indexOf('printf "{}\\n"')).toBeLessThan(script.indexOf('exit 0'))
  })

  it('emits neutral JSON before anything can exit early, on Windows', () => {
    const lines = scriptForPlatform('win32').split('\r\n')

    // Why: same precision as the POSIX case above - an exact offset, so moving the endpoint load
    // (or anything else) ahead of the neutral JSON fails the test instead of silently passing.
    expect(lines.indexOf('echo {}')).toBe(lines.indexOf('setlocal') + 1)
    expect(lines.indexOf('echo {}')).toBeLessThan(
      lines.findIndex((line) => line.startsWith('exit /b'))
    )
  })
})
