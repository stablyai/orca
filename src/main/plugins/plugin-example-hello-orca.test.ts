import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../../shared/plugins/installation/plugin-host-version'
import { inspectPluginInstallTree } from './installation/plugin-install-staging'
import { createPluginWorkerRuntime } from './workers/plugin-host-runtime'

const root = join(process.cwd(), 'examples', 'plugins', 'hello-orca')

it('ships a worker that counts for its panel', async () => {
  const inspection = await inspectPluginInstallTree({
    rootDir: root,
    hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE,
    identity: { pluginKey: 'samples.hello-orca' }
  })
  expect(inspection).toMatchObject({ ok: true })
  if (!inspection.ok) {
    return
  }
  const panel = {
    id: 'panel-1',
    surface: 'panel',
    contributionId: inspection.manifest.contributes.panels[0]!.id
  }

  const send = vi.fn()
  const runtime = createPluginWorkerRuntime({ send, exit: vi.fn() })
  await runtime.handleMessage({
    orca: 1,
    kind: 'evt',
    event: 'init',
    payload: {
      pluginId: 'samples.hello-orca',
      pluginRoot: root,
      mainEntry: 'main.mjs',
      grantedCapabilities: []
    }
  })
  const ask = async (id: number, name: string) => {
    await runtime.handleMessage({
      orca: 1,
      kind: 'req',
      id,
      method: 'panel.request',
      params: { name, input: null, panel }
    })
    return send.mock.calls.map(([sent]) => sent).find((sent) => sent.id === id)
  }

  expect(await ask(1, 'clicks.increment')).toMatchObject({ result: { clicks: 1 } })
  expect(await ask(2, 'clicks.increment')).toMatchObject({ result: { clicks: 2 } })
  expect(await ask(3, 'clicks.get')).toMatchObject({ result: { clicks: 2 } })
  expect(await ask(4, 'clicks.reset')).toMatchObject({ error: { code: 'unknown_method' } })
})
