import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePluginManifest } from '../../shared/plugins/plugin-manifest'
import { pluginTaskPageSchema } from '../../shared/plugins/plugin-task-source-contract'
import { invokePluginTaskSourceMethod } from './plugin-task-source-invoker'
import { createPluginWorkerRuntime } from './plugin-host-runtime'
import type { PluginWorkerChildMessage } from '../../shared/plugins/plugin-host-protocol'

const ROOT = join(__dirname, '../../../examples/plugins/task-source-demo')

describe('task source end to end', () => {
  it('parses the fixture manifest', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8'))

    expect(parsePluginManifest(raw)).toMatchObject({ ok: true })
  })

  it('carries fixture items from the worker through the invoker', async () => {
    const sent: PluginWorkerChildMessage[] = []
    const runtime = createPluginWorkerRuntime({ send: (message) => sent.push(message) })

    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.task-source-demo',
      pluginRoot: ROOT,
      mainEntry: 'main.mjs',
      grantedCapabilities: []
    })

    const result = await invokePluginTaskSourceMethod({
      callWorker: async (request) => {
        await runtime.handleMessage({
          type: 'invokeTaskSource',
          callId: 99,
          sourceId: request.sourceId,
          method: request.method,
          params: request.params
        })
        const message = sent.find(
          (entry) => entry.type === 'taskSourceResult' && entry.callId === 99
        )
        return message && 'value' in message ? message.value : null
      },
      pluginKey: 'orca-samples.task-source-demo',
      sourceId: 'demo-tasks',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 },
      resultSchema: pluginTaskPageSchema
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.data.items[0].title).toBe('Ship the task source platform')
  })
})
