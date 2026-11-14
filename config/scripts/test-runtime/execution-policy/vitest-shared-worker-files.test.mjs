import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { filesSafeToShareWorker } from './vitest-shared-worker-files.mjs'

it('isolates hook-owned fixtures reached through test support without a Vitest import', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-shared-worker-39256-'))
  try {
    writeFileSync(join(directory, 'safe.test.ts'), "import { it } from 'vitest'\n")
    writeFileSync(join(directory, 'owned.test.ts'), "import './database-test-support'\n")
    writeFileSync(join(directory, 'database-test-support.ts'), "import './database-test-harness'\n")
    writeFileSync(join(directory, 'database-test-harness.ts'), "import './bundle.test-fixture'\n")
    writeFileSync(
      join(directory, 'bundle.test-fixture.ts'),
      "// @orca-isolated-worker -- Hooks own a temporary bundle.\nimport { afterAll } from 'vitest'\n"
    )

    expect(filesSafeToShareWorker(directory, ['safe.test.ts', 'owned.test.ts'])).toEqual([
      'safe.test.ts'
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
