import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginSourceModuleCompiler } from './plugin-frame-module-transform'
import { createPluginSourceTranspileClient } from '../plugin-source-transpile-client'
import type {
  PluginSourceTranspileRequest,
  PluginSourceTranspileResponse,
  PluginSourceTranspileWorkerReady
} from '../source-transpilation/plugin-source-transpile-protocol'
import { transpilePluginSource } from '../source-transpilation/plugin-source-transpiler'
import { inProcessWorker } from '../../../worker-threads/in-process-worker.test-fixture'

const BUDGET_MS = 100
const SOURCE = 'export const answer: number = 42\n'
const TRANSPILED = 'export const answer = 42\n'
const TIMEOUT_MODULE =
  'throw new Error("main.ts: took over the 100 ms transpile budget; split it into smaller modules")\n'
const READY: PluginSourceTranspileWorkerReady = { ready: true }

function setup(source = SOURCE) {
  const requests: PluginSourceTranspileRequest[] = []
  const worker = inProcessWorker((request: PluginSourceTranspileRequest) => {
    requests.push(request)
    const response: PluginSourceTranspileResponse = {
      id: request.id,
      result: transpilePluginSource(request.relativePath, request.source)
    }
    return response
  }, READY)
  const compile = createPluginSourceModuleCompiler({
    transpile: createPluginSourceTranspileClient({
      createWorker: worker.factory,
      budgetMs: BUDGET_MS
    })
  })
  const startLoad = (): Promise<string> =>
    compile({
      relativePath: 'main.ts',
      bytes: new TextEncoder().encode(source),
      exists: async () => false
    })
  const load = async (): Promise<string> => {
    const pending = startLoad()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    return pending
  }
  return { load, startLoad, requests, controls: worker.controls }
}

describe('createPluginSourceModuleCompiler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a file after a transpile budget timeout once its retry delay passes', async () => {
    const { load, controls } = setup()
    controls.hangsOn = () => controls.spawned === 1

    expect(await load()).toBe(TIMEOUT_MODULE)
    expect(await load()).toBe(TIMEOUT_MODULE)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await load()).toContain(TRANSPILED)
  })

  it('keeps a transform error cached without retrying', async () => {
    const { load, requests } = setup('export const = 1\n')

    const first = await load()
    expect(first).toContain('Unexpected token')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await load()).toBe(first)
    expect(requests).toHaveLength(1)
  })

  it('shares one transpile between concurrent loads of the same file', async () => {
    const { startLoad, requests } = setup()

    const loads = Promise.all([startLoad(), startLoad(), startLoad()])
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    const modules = await loads
    expect(modules.every((code) => code.includes(TRANSPILED))).toBe(true)
    expect(requests).toHaveLength(1)
  })
})
