import { runInNewContext } from 'node:vm'
import { ORCAD_BUN_VERSION } from '../shared/orcad-bun-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBundledBunFixture } from './bundled-bun-test-execution'

const { run, exists } = vi.hoisted(() => ({ run: vi.fn(), exists: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: exists }))
vi.mock('../shared/child-process/run-process', () => ({ runProcess: run }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('bundled Bun fixture launch environment', () => {
  it.each([undefined, { output: 'captured' }])(
    'serializes a completed fixture result: %j',
    async (value) => {
      exists.mockReturnValue(true)
      run.mockImplementationOnce(async (spec) => {
        let stdout = ''
        await runInNewContext(spec.args[1], {
          require: (name: string) =>
            name === 'node:fs'
              ? { readFileSync: () => spec.input }
              : { capture: async () => value },
          process: {
            versions: { bun: ORCAD_BUN_VERSION },
            stdout: {
              write: (chunk: string) => {
                stdout += chunk
              }
            }
          },
          console
        })
        return { code: 0, stdout, stderr: '', timedOut: false, outputTruncated: false }
      })
      expect(await runBundledBunFixture('/fixture.ts', 'capture', null, 1000)).toEqual(
        value ?? null
      )
    }
  )
  it('removes runtime injection while retaining explicit fixture arguments and shell environment', async () => {
    exists.mockReturnValue(true)
    run.mockResolvedValue({
      code: 0,
      stdout: '"done"',
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'BUN_OPTIONS',
      'BUN_INSPECT',
      'BUN_INSPECT_WAIT'
    ]) {
      vi.stubEnv(key, 'injected-runtime-setting')
    }
    vi.stubEnv('SHELL', '/bin/zsh')
    const args = { env: { NODE_OPTIONS: '--fixture-shell-option' } }
    expect(await runBundledBunFixture('/fixture.ts', 'capture', args, 1000)).toBe('done')
    const spec = run.mock.calls[0][0]
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'BUN_OPTIONS',
      'BUN_INSPECT',
      'BUN_INSPECT_WAIT'
    ]) {
      expect(spec.env[key]).toBeUndefined()
    }
    expect(spec.env.SHELL).toBe('/bin/zsh')
    expect(spec.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(JSON.parse(spec.input)).toEqual(args)
  })
})
