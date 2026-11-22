import { EventEmitter } from 'node:events'
import { expect, it, onTestFinished, vi } from 'vitest'
import { getPtyIpc, getPtyPower, noopPtyIpcSurface, setPtyHostBindings } from '../pty-host-bindings'
import { makeRuntimePtySpawnTestDeps } from '../runtime/spawn-preflight-test-deps-fixture'
import { installPtySpawnIpcHandler } from './spawn'
import { runPtyIpcSpawn } from './spawn-run'

vi.mock('./spawn-run', () => ({ runPtyIpcSpawn: vi.fn() }))

it('cancels a direct PTY restart when the originating document navigates', async () => {
  const previousIpc = getPtyIpc()
  const power = getPtyPower()
  const handle = vi.fn()
  setPtyHostBindings({ ipc: { ...noopPtyIpcSurface, handle }, power })
  onTestFinished(() => setPtyHostBindings({ ipc: previousIpc, power }))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.mocked(runPtyIpcSpawn).mockImplementation(async (_deps, request) => {
    entered.resolve()
    await release.promise
    if (request.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    return { id: 'replacement-pty' }
  })
  const { getSettings: _settings, ...deps } = makeRuntimePtySpawnTestDeps()
  installPtySpawnIpcHandler({
    ...deps,
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    syncPtyBackgroundedDelivery: () => {},
    stopReplacedPty: async () => {}
  })
  const invoke = handle.mock.calls.find(([channel]) => channel === 'pty:spawn')![1]
  const frame = {}
  const sender = Object.assign(new EventEmitter(), { id: 14, mainFrame: frame })
  const pane = {
    worktreeId: 'workspace',
    tabId: 'terminal-tab',
    leafId: '11111111-1111-4111-8111-111111111111',
    tabCreatedAt: 1
  }
  const pending: Promise<unknown> = invoke(
    { sender, senderFrame: frame },
    {
      ...pane,
      cols: 80,
      rows: 24,
      accountRestart: {
        requestId: 'restart-request',
        attemptId: 'restart-attempt',
        hostEpoch: 'host-epoch',
        pane,
        expected: {
          kind: 'endpoint',
          ptyId: 'original-pty',
          incarnationId: 'original-incarnation',
          bindingGeneration: 1
        }
      }
    }
  )
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('restart did not reach the spawn operation')
      })
    ])
    sender.emit('did-navigate')
  } finally {
    release.resolve()
  }
  await expect(pending).rejects.toThrow('client_disconnected')
})
