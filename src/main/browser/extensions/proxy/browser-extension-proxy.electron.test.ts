import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runElectronFixture } from '../../electron-fixtures/electron-fixture-run'

// Bundling and launching the separate Electron fixture can exceed the default test timeout.
it('routes extension proxy settings and PAC rules, isolates profiles, and restores underlying policies', async () => {
  const result = await runElectronFixture(
    join(import.meta.dirname, 'browser-extension-proxy-electron-fixture.ts')
  )
  expect(result.code, result.stdout + result.stderr).toBe(0)
}, 60_000)

// Bundling and launching the separate Electron fixture can exceed the default test timeout.
it('reads native proxy whitespace and rejects unrepresentable mixed direct routes', async () => {
  const result = await runElectronFixture(
    join(import.meta.dirname, 'browser-extension-proxy-readback-electron-fixture.ts')
  )
  expect(result.code, result.stdout + result.stderr).toBe(0)
}, 60_000)
