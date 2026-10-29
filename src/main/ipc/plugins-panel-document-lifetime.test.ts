import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import { panelSessionTokenSchema } from '../../shared/plugins/frames/plugin-frame-bridge'
import type { Store } from '../persistence'
import { PluginContentVerifier } from '../plugins/plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugins/plugin-discovery'
import { PluginPanelController } from '../plugins/panels/plugin-panel-controller'
import { PluginPanelSessions } from '../plugins/panels/plugin-panel-sessions'
import type { PluginService } from '../plugins/plugin-service'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  }
}))

const { registerPluginHandlers } = await import('./plugins')
const roots: string[] = []
const controllers: PluginPanelController[] = []
const senders: EventEmitter[] = []
const PREDECESSOR = 'orca-samples.predecessor'
const SUCCESSOR = 'orca-samples.successor'
const entrySchema = z.object({ html: z.string(), sessionToken: panelSessionTokenSchema })

beforeEach(() => mocks.handlers.clear())
afterEach(async () => {
  for (const sender of senders.splice(0)) {
    sender.emit('destroyed')
  }
  for (const controller of controllers.splice(0)) {
    controller.dispose()
  }
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(id: string): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-panel-document-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'panel.html'), `<h1>${id}</h1>`)
  return {
    pluginKey: `orca-samples.${id}`,
    rootDir,
    contentHash: null,
    consentFingerprint: 'approved',
    isDev: true,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id,
      publisher: 'orca-samples',
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { panels: [{ id: 'panel', title: id, entry: 'panel.html' }] },
      capabilities: [{ kind: 'notifications:show' }]
    })
  }
}

async function harness(
  options: {
    beforeVerify?: (plugin: ValidDiscoveredPlugin) => Promise<void>
    whenReady?: () => Promise<void>
  } = {}
) {
  const plugins = new Map(
    (await Promise.all([plugin('predecessor'), plugin('successor')])).map((entry) => [
      entry.pluginKey,
      entry
    ])
  )
  const verifier = new PluginContentVerifier()
  const verified: string[] = []
  const panels = new PluginPanelController({
    resolveApprovedPlugin: (key) => plugins.get(key) ?? null,
    contentVerifier: {
      verify: async (entry) => {
        verified.push(entry.pluginKey)
        const discovered = plugins.get(entry.pluginKey)
        if (!discovered) {
          throw new Error('Missing approved plugin')
        }
        await options.beforeVerify?.(discovered)
        await verifier.verify(entry)
      }
    },
    executeHostCall: async (pluginKey) => ({ ok: true, value: { pluginKey } }),
    log: () => () => {}
  })
  controllers.push(panels)
  const service = { panels, whenReady: options.whenReady ?? (async () => {}) }
  registerPluginHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration uses this store only to subscribe to settings updates.
    { onSettingsChanged: () => () => {} } as unknown as Store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: panel handlers consume real controller and readiness members only.
    service as unknown as PluginService,
    null
  )
  return { verified }
}

function sender(id = 1) {
  const contents = Object.assign(new EventEmitter(), { id })
  senders.push(contents)
  return contents
}

function invoke(name: string, contents: ReturnType<typeof sender>, args: unknown) {
  const handler = mocks.handlers.get(`plugins:${name}`)
  if (!handler) {
    throw new Error(`Missing handler ${name}`)
  }
  return handler({ sender: contents }, args)
}

function open(contents: ReturnType<typeof sender>, pluginKey = SUCCESSOR) {
  return invoke('readPanelEntry', contents, { pluginKey, panelId: 'panel' })
}

function action(contents: ReturnType<typeof sender>, sessionToken: string) {
  return invoke('panelAction', contents, {
    sessionToken,
    action: 'notifications.show',
    params: { title: 'Live panel' }
  })
}

describe('plugin panel document ownership', () => {
  it('preserves successor and sibling authority when a crashed document finishes loading late', async () => {
    const entered = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    await harness({
      beforeVerify: async (entry) => {
        if (entry.pluginKey === PREDECESSOR) {
          entered.resolve()
          await blocked.promise
        }
      }
    })
    const current = sender()
    const oldRequest = open(current, PREDECESSOR)
    await entered.promise
    current.emit('render-process-gone')
    const successor = entrySchema.parse(await open(current))
    const other = sender(2)
    const sibling = entrySchema.parse(await open(other))
    await expect(action(current, successor.sessionToken)).resolves.toMatchObject({ ok: true })
    blocked.resolve()
    await expect(oldRequest).resolves.toBeNull()
    await expect(action(current, successor.sessionToken)).resolves.toEqual({
      ok: true,
      value: { pluginKey: SUCCESSOR }
    })
    await expect(action(other, sibling.sessionToken)).resolves.toMatchObject({ ok: true })
    expect(entrySchema.parse(await open(current)).sessionToken).toBe(successor.sessionToken)
    current.emit('destroyed')
    await expect(action(current, successor.sessionToken)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request'
    })
    await expect(action(other, sibling.sessionToken)).resolves.toMatchObject({ ok: true })
    expect(current.eventNames()).toEqual([])
  })

  it('skips loading a request retired while plugin discovery is pending', async () => {
    const ready = Promise.withResolvers<void>()
    const { verified } = await harness({ whenReady: () => ready.promise })
    const current = sender()
    const pending = open(current, PREDECESSOR)
    current.emit('render-process-gone')
    ready.resolve()
    await expect(pending).resolves.toBeNull()
    expect(verified).toEqual([])
    const successor = entrySchema.parse(await open(current))
    await expect(action(current, successor.sessionToken)).resolves.toMatchObject({ ok: true })
  })

  it('does not issue a panel session after native owner destruction during a load', async () => {
    const entered = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    await harness({
      beforeVerify: async () => {
        entered.resolve()
        await blocked.promise
      }
    })
    const issue = vi.spyOn(PluginPanelSessions.prototype, 'issue')
    const current = sender()
    const pending = open(current)
    await entered.promise
    current.emit('destroyed')
    blocked.resolve()
    await expect(pending).resolves.toBeNull()
    expect(issue).not.toHaveBeenCalled()
    expect(current.eventNames()).toEqual([])
  })
})
