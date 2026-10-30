import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../../shared/plugins/installation/plugin-host-version'
import { inspectPluginInstallTree } from './installation/plugin-install-staging'
import { createPluginWorkerRuntime } from './workers/plugin-host-runtime'

const root = join(process.cwd(), 'examples', 'plugins', 'hello-orca')

it('ships a worker that counts for the panel it declares', async () => {
  const inspection = await inspectPluginInstallTree({
    rootDir: root,
    hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE,
    identity: { pluginKey: 'samples.hello-orca' }
  })
  expect(inspection).toMatchObject({ ok: true })
  if (!inspection.ok) {
    return
  }
  const panelId = inspection.manifest.contributes.panels[0]!.id

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
  const ask = async (id: number, message: unknown) => {
    await runtime.handleMessage({
      orca: 1,
      kind: 'req',
      id,
      method: 'panel.message',
      params: { panelId, message }
    })
    return send.mock.calls.map(([sent]) => sent).find((sent) => sent.id === id)
  }

  expect(await ask(1, { type: 'increment' })).toMatchObject({ result: { clicks: 1 } })
  expect(await ask(2, { type: 'increment' })).toMatchObject({ result: { clicks: 2 } })
  expect(await ask(3, { type: 'get' })).toMatchObject({ result: { clicks: 2 } })
  expect(await ask(4, { type: 'reset' })).toMatchObject({ error: { code: 'action_failed' } })
})
