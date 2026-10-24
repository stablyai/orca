import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn((_path: string) => false) }))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: existsSyncMock
}))

import { resolveDesktopScriptProviderPath } from './desktop-script-provider-paths'

describe('resolveDesktopScriptProviderPath', () => {
  afterEach(() => {
    existsSyncMock.mockReset()
  })

  it('finds the runtime orcad ships beside its sidecar when there is no resourcesPath', () => {
    const bundled = join(__dirname, 'computer-use-linux', 'runtime.py')
    existsSyncMock.mockImplementation((path) => path === bundled)

    expect(resolveDesktopScriptProviderPath('linux')).toBe(bundled)
  })
})
