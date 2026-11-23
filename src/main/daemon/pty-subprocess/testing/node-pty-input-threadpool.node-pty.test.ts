import { runProcess } from '@orca/process-host'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ORCAD_NODE_PTY_DIR } from '../../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'

const require = createRequire(import.meta.url)
const worker = fileURLToPath(new URL('./node-pty-input-worker.cjs', import.meta.url))
const packagePath = (process.env.ORCA_REQUIRED_TEST_INPUTS ?? '').split(',').includes('artifact')
  ? resolve('out/orcad', ORCAD_NODE_PTY_DIR)
  : require.resolve('node-pty')

describe.skipIf(process.platform === 'win32')('Unix PTY input under worker-pool starvation', () => {
  it('delivers input without the pool while retaining paste ordering and nonblocking backpressure', async () => {
    for (const mode of ['threadpool', 'paste', 'backpressure']) {
      const result = await runProcess({
        program: process.execPath,
        args: [worker, packagePath, mode],
        env: { ...process.env, UV_THREADPOOL_SIZE: '1', ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 8_000,
        maxOutputBytes: 4096
      })
      expect(result.timedOut, mode).toBe(false)
      expect(result.code, `${mode}: ${result.stderr}`).toBe(0)
      expect(result.stderr).not.toContain('Unhandled pty write error')
      expect(result.stdout).toContain('input delivered')
    }
  })
})
