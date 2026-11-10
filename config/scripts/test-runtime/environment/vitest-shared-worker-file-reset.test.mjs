import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { expect, it } from 'vitest'
import { resolvePinnedBunExecutable } from '../../tool-invocation/pinned-bun-executable.mjs'

const root = fileURLToPath(new URL('../../../..', import.meta.url))

it('restores environment stubs and finishes background imports before the next shared file', async () => {
  const cache = join(root, 'node_modules/.cache')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'shared-worker-reset-'))
  const write = (name, source) => writeFileSync(join(directory, name), source)
  try {
    write(
      'vitest.config.mjs',
      `import { defineConfig } from 'vitest/config'
       import { BaseSequencer } from 'vitest/node'
       class Ordered extends BaseSequencer {
         async sort(specs) { return specs.sort((a, b) => a.moduleId.localeCompare(b.moduleId)) }
       }
       export default defineConfig({ test: {
         root: ${JSON.stringify(directory)},
         include: ['*.spec.mjs'], isolate: false, maxWorkers: 1,
         setupFiles: ['./assert-import-finished.mjs', ${JSON.stringify(resolve(root, 'config/scripts/test-runtime/environment/vitest-shared-worker-file-reset.mjs'))}],
         sequence: { sequencer: Ordered }
       } })`
    )
    write(
      'assert-import-finished.mjs',
      `import { afterAll, expect } from 'vitest'
       import { readFileSync } from 'node:fs'
       afterAll(() => expect(readFileSync(new URL('./result', import.meta.url), 'utf8')).toBe('loaded'))`
    )
    write(
      'import-started.mjs',
      `export let started
       export const ready = new Promise(resolve => { started = resolve })`
    )
    write(
      'background.mjs',
      `import { setImmediate } from 'node:timers/promises'
       import { writeFileSync } from 'node:fs'
       import { started } from './import-started.mjs'
       started()
       await setImmediate()
       writeFileSync(new URL('./result', import.meta.url), 'loaded')`
    )
    write(
      '01-replace-env.spec.mjs',
      `import { it } from 'vitest'
       import { ready } from './import-started.mjs'
       it('replaces env and starts a background import', async () => {
         process.env = { ...process.env }
         void import('./background.mjs')
         await ready
       })`
    )
    write(
      '02-stub-env.spec.mjs',
      `import { expect, it, vi } from 'vitest'
       it('removes an environment override after a previous file replaced env', () => {
         vi.stubEnv('ORCA_SHARED_WORKER_OVERRIDE', 'asia-east2')
         vi.unstubAllEnvs()
         expect(process.env.ORCA_SHARED_WORKER_OVERRIDE).toBeUndefined()
       })`
    )
    const result = await runProcess({
      program: resolvePinnedBunExecutable(root, runProcessSync) ?? 'bun',
      args: [
        '--bun',
        resolve(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        join(directory, 'vitest.config.mjs')
      ],
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 30_000
    })
    expect(result.code, result.stdout + result.stderr).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
