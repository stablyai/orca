import { expect, it } from 'vitest'
import {
  pluginCancel,
  pluginEvent,
  pluginRequest,
  pluginResult
} from '../../../../shared/plugins/frames/plugin-protocol'
import type { PluginWorkerOrcaApi } from '../../../../shared/plugins/workers/plugin-worker-orca-api'
import { createPluginWorkerRuntime } from './plugin-host-runtime'

it('acknowledges idle only after all handlers, including a cancelled handler, have returned', async () => {
  const idle: unknown[] = []
  const runtime = createPluginWorkerRuntime({
    send(message) {
      if (message.kind === 'evt' && message.event === 'idle') {
        idle.push(message.payload)
      }
    },
    importModule: async () => ({
      sleepWhenIdle: true,
      default(orca: PluginWorkerOrcaApi) {
        orca.commands.register('work', () => orca.storage.get('key'))
      }
    })
  })
  await runtime.handleMessage(
    pluginEvent('init', {
      pluginId: 'test.worker',
      pluginRoot: '/',
      mainEntry: 'worker.mjs',
      grantedCapabilities: ['storage:own']
    })
  )
  const first = runtime.handleMessage(pluginRequest(0, 'command.invoke', { commandId: 'work' }))
  const second = runtime.handleMessage(pluginRequest(1, 'command.invoke', { commandId: 'work' }))
  await runtime.handleMessage(pluginCancel(0))
  await runtime.handleMessage(pluginResult(1, 'second finished'))
  await second
  expect(idle).toEqual([{ through: -1 }])
  await runtime.handleMessage(pluginResult(0, 'first finished'))
  await first
  expect(idle).toEqual([{ through: -1 }, { through: 1 }])
})
