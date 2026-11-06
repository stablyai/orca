import { describe, expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

describe('WSL move fence routing', () => {
  const spec = 'tests/e2e/wsl-move-fence.spec.ts'

  it.each([
    'src/main/persistence/moving-wsl-projects/wsl-move-reset.ts',
    'src/main/persistence/moving-wsl-projects/wsl-move-scope-guard.ts',
    'src/main/ipc/pty/host-env/spawn-cwd.ts',
    'src/main/wsl/host-lifecycle/wsl-host-gate.ts',
    'src/shared/wsl-move/wsl-move-cutover.ts'
  ])('routes %s', (file) => {
    expect(selectPrE2eSpecs([file])).toContain(spec)
  })

  it.each([
    'src/main/persistence/moving-wsl-projects/wsl-move-reset.test.ts',
    'src/main/persistence/moving-wsl-projects/wsl-move-driver.ts',
    'src/shared/wsl-move/wsl-move-cutover-extra.ts'
  ])('does not route %s', (file) => {
    expect(selectPrE2eSpecs([file])).not.toContain(spec)
  })
})
