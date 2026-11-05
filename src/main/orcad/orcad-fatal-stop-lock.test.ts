import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import { ORCAD_LOCK_FILE_NAME } from './orcad-instance-lock'
import { installOrcadShutdownSignals, startOrcadWithHost } from './orcad-lifecycle'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('a fatal orcad stop', () => {
  // A released lock reads as a clean exit, so a run that died of an uncaught exception would never count as a crash.
  it('keeps the instance lock so the next start reports the run as unexpected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-fatal-stop-'))
    roots.push(root)
    vi.spyOn(process, 'on').mockImplementation(() => process)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub only records the code; nothing after process.exit runs here.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const handle = await startOrcadWithHost(
      root,
      async () => ({}),
      () => {}
    )

    installOrcadShutdownSignals(() => handle.stop())('uncaught exception', undefined, 1)

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  })
})
