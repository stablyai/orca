import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runElectronFixture } from '../../browser/electron-fixtures/electron-fixture-run'

describe('main window webview security teardown', () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('revokes preview grants when the window is destroyed before its WebContents', async () => {
    const result = await runElectronFixture(
      join(
        import.meta.dirname,
        '../testing/main-window-webview-security-destroy-electron-fixture.ts'
      )
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.output).toEqual({ uncaught: [], grantRevoked: true })
  }, 60_000)
})
