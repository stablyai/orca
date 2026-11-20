import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectLinuxElectronLifecycleInputs,
  linuxElectronLifecycleScope
} from './linux-electron-lifecycle-scope.mjs'

const projectDir = resolve(import.meta.dirname, '../../../..')

describe('Linux Electron lifecycle scope', () => {
  // Skipping on a fixture-only input would let a PR break these tests unseen until main.
  it('runs for sources that fixtures bundle by path and skips unrelated changes', async () => {
    const inputs = await collectLinuxElectronLifecycleInputs(projectDir)
    for (const file of [
      'src/main/browser/extensions/api-runtime/browser-extension-electron-fixture.ts',
      'src/renderer/src/hooks/ipc-events/browser/browser-link-materialization.test-fixture.tsx',
      'src/packages/process-host/package.json'
    ]) {
      expect(linuxElectronLifecycleScope([file], inputs).run, file).toBe(true)
    }
    expect(
      linuxElectronLifecycleScope(['docs/README.md', 'src/main/git/status.ts'], inputs).run
    ).toBe(false)
    expect(linuxElectronLifecycleScope([], inputs).run).toBe(true)
  }, 60_000)
})
