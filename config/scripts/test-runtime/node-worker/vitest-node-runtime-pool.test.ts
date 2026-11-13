import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import { createVitest } from 'vitest/node'

import { nodeRuntimePool } from './vitest-node-runtime-pool'

it('reports a test file that fails to load as a failed file instead of crashing the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-node-runtime-pool-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'load-failure.test.ts'), "import './orca-missing-module'\n")
  const nested = await createVitest(
    'test',
    {
      config: false,
      watch: false,
      dir,
      include: ['**/*.test.ts'],
      pool: 'node-runtime',
      poolRunner: nodeRuntimePool,
      reporters: [],
      env: { ORCA_TEST_NODE_EXECUTABLE: process.execPath }
    },
    {
      cacheDir: join(dir, 'vite-cache'),
      test: { fsModuleCachePath: join(dir, 'module-cache') }
    },
    { stdout: new PassThrough(), stderr: new PassThrough() }
  )
  try {
    await nested.start()
    const [file] = nested.state.getFiles()
    expect(file.result?.state).toBe('fail')
    expect(file.result?.errors?.[0]?.message).toContain('orca-missing-module')
    expect(nested.state.getUnhandledErrors()).toEqual([])
  } finally {
    await nested.close()
  }
})
