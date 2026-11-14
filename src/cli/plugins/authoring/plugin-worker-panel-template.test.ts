import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { findPluginTestFiles, runPluginTests } from './plugin-test-runner'

const TSC = resolve(__dirname, '../../../../node_modules/typescript/bin/tsc')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workerPanelPlugin(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-worker-panel-')))
  roots.push(root)
  const dir = join(root, 'counter')
  await createPluginFromTemplate({ dir, template: 'worker-panel' })
  return dir
}

describe('orca plugin create --template worker-panel', () => {
  it(
    "passes its own panel and worker tests under `orca plugin test` on Orca's runtime",
    async () => {
      const dir = await workerPanelPlugin()
      const files = await findPluginTestFiles(dir)
      expect(files).toEqual(['src/panel.test.tsx', 'src/worker.test.ts'])
      const orca = {
        program: process.execPath,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        source: 'orca' as const,
        version: process.version
      }
      expect(await runPluginTests({ dir, files, quietStdout: true, node: orca })).toEqual({
        runner: 'node',
        code: 0,
        node: 'orca'
      })
    },
    // Starts its own Node process and transpiles the plugin.
    60_000
  )

  it(
    'type-checks against the typings it writes',
    async () => {
      const dir = await workerPanelPlugin()
      const result = await runProcess({
        program: process.execPath,
        args: [TSC, '-p', dir],
        cwd: dir,
        env: { ...process.env, PWD: dir },
        timeoutMs: 60_000,
        maxOutputBytes: 256 * 1024
      })
      expect(result.timedOut).toBe(false)
      expect(result.code, `${result.stdout}${result.stderr}`).toBe(0)
    },
    // Runs real tsc over the scaffold and Orca's typings, which takes a while on CI.
    90_000
  )
})
