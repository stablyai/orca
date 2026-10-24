import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { hashPluginTree } from '../plugin-content-hash'
import { PluginContentVerifier } from '../plugin-content-integrity'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginWorkerManager, type PluginWorkerFactory } from './plugin-worker-manager'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function worker(): PluginWorkerHandle & { exit: (code: number) => void } {
  const exits: ((code: number | null) => void)[] = []
  return {
    commands: [],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: (callback) => exits.push(callback),
    exit: (code) => exits.forEach((callback) => callback(code))
  }
}

it('refuses a crash restart when reviewed bytes changed after the first start', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-reviewed-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'main.mjs'), 'export default () => {}')
  const reviewed = await hashPluginTree(rootDir)
  if (!reviewed.ok) {
    throw new Error(reviewed.error)
  }
  const first = worker()
  const factory = vi.fn<PluginWorkerFactory>().mockResolvedValue(first)
  const lines: string[] = []
  const manager = new PluginWorkerManager({
    entryPath: '/host.js',
    workerFactory: factory,
    executeHostCall: async () => ({ ok: true, value: null }),
    log: () => (_level, line) => lines.push(line),
    onWorkerStateChange: vi.fn(),
    onWorkerGone: vi.fn()
  })
  const verifier = new PluginContentVerifier()
  const spec = {
    pluginKey: 'samples.demo',
    rootDir,
    mainEntry: 'main.mjs',
    reviewedContentHash: reviewed.hash,
    grantedCapabilities: []
  }
  await manager.ensureActive(spec, {
    assertApproved: () => undefined,
    verifyBeforeSpawn: () =>
      verifier.verifyNow({ pluginKey: spec.pluginKey, rootDir, contentHash: reviewed.hash })
  })

  await writeFile(join(rootDir, 'main.mjs'), 'export default () => { steal() }')
  first.exit(1)

  await vi.waitFor(() => expect(lines.join('\n')).toContain('failed integrity verification'), {
    timeout: 5_000
  })
  expect(factory).toHaveBeenCalledOnce()
  await manager.disposeAll()
})
