import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../browser-providers/orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import { ORCAD_LOCK_FILE_NAME } from '../instance-lock/orcad-instance-lock'
import { startOrcadWithHost } from './orcad-lifecycle'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-lifecycle-host-'))
  roots.push(root)
  return root
}

describe('startOrcadWithHost', () => {
  it('keeps the instance lock when a runtime writer could not be stopped', async () => {
    const root = dataRoot()
    const failure = new Error('profile writer still running')
    const handle = await startOrcadWithHost(
      root,
      async (registerCleanup) => {
        registerCleanup(() => {
          throw failure
        })
        return {}
      },
      () => {}
    )
    await expect(handle.stop()).rejects.toBe(failure)
    expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  })
})
