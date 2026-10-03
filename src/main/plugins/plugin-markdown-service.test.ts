import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import type { PluginMarkdownWorkerResult } from '../../shared/plugins/plugin-markdown-renderer'
import { PluginService } from './plugin-service'
import type { PluginWorkerHandle } from './plugin-host-process'

const roots: string[] = []
const services: PluginService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('native Markdown service integration', () => {
  it('uses discovered consented commands with exact local document context and refuses stale consent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-markdown-service-'))
    roots.push(root)
    const documentPath = join(root, 'note.md')
    await writeFile(documentPath, '# Note')
    const pluginRoot = join(root, 'provider')
    await mkdir(pluginRoot)
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      publisher: 'orca-samples',
      id: 'query',
      name: 'Query',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'worker.mjs',
      contributes: {
        commands: [{ id: 'render-query', title: 'Render' }],
        markdownRenderers: [{ language: 'query', commandId: 'render-query' }]
      }
    })
    await writeFile(join(pluginRoot, 'orca-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(pluginRoot, 'worker.mjs'), 'export default async function () {}')
    const response: PluginMarkdownWorkerResult = {
      sessionId: 'block',
      revision: 'r1',
      output: {
        kind: 'table',
        columns: ['Note'],
        rows: [[{ text: 'Note', reference: { path: 'note.md', base: 'workspace' } }]]
      }
    }
    const invoke = vi.fn().mockResolvedValue(response)
    const worker: PluginWorkerHandle = {
      commands: ['render-query'],
      invokeCommand: invoke,
      deliverEvent: vi.fn(),
      lastActivityAt: () => Date.now(),
      inFlightCount: () => 0,
      dispose: vi.fn(async () => undefined),
      kill: vi.fn(),
      onExit: vi.fn()
    }
    let consent = fingerprintPluginConsent(manifest)
    const factory = vi.fn(async () => worker)
    const service = new PluginService({
      userDataPath: join(root, 'data'),
      hostVersion: '1.0.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({ 'orca-samples.query': consent }),
      getDevPluginPaths: () => [pluginRoot],
      workerFactory: factory
    })
    services.push(service)
    const active = vi.fn(async () => null)
    const scope = vi.fn(async () => ({
      id: 'repo::notes',
      path: root,
      connectionId: null,
      repo: { id: 'repo', path: root, displayName: 'Notes', badgeColor: '', addedAt: 0 },
      folderWorkspace: null
    }))
    service.setRuntimeDelegate({
      getRuntimeId: () => 'runtime',
      showTerminalWorkspaceLaunchScope: scope,
      resolveActiveWorktreeContext: active,
      listTerminals: async () => ({ terminals: [] }),
      sendTerminal: async () => ({ accepted: false }),
      dispatchPluginNotification: async () => ({ delivered: false })
    })
    await service.initialize()
    const source = await service.markdown.resolveSource({
      documentPath,
      fileId: 'file',
      worktreeId: 'repo::notes',
      runtimeEnvironmentId: null
    })
    if (source.status !== 'resolved') {
      throw new Error('expected source fixture')
    }
    const request = {
      language: 'query',
      code: 'LIST',
      source: source.source,
      sessionId: 'block',
      knownRevision: 'r0'
    }
    expect(await service.markdown.render('renderer:1', request)).toEqual({
      status: 'rendered',
      pluginKey: 'orca-samples.query',
      ...response
    })
    expect(invoke).toHaveBeenCalledWith('render-query', request)
    expect(factory).toHaveBeenCalledOnce()
    expect(scope).toHaveBeenCalledWith('id:repo::notes')
    expect(active).not.toHaveBeenCalled()
    consent = 'stale-fingerprint'
    expect(service.markdown.list()).toEqual([
      { language: 'query', pluginKey: 'orca-samples.query', available: false }
    ])
    expect(await service.markdown.render('renderer:1', request)).toEqual({
      status: 'unavailable',
      reason: 'disabled-provider'
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    consent = fingerprintPluginConsent(manifest)
    let finishRender: (value: unknown) => void = () => undefined
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRender = resolve
        })
    )
    const pending = service.markdown.render('renderer:1', request)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    let finishRemoval: () => void = () => undefined
    const removal = service.removePlugin(
      'orca-samples.query',
      () =>
        new Promise((resolve) => {
          finishRemoval = resolve
        })
    )
    await vi.waitFor(() => expect(service.markdown.list()[0]?.available).toBe(false))
    finishRender(response)
    expect(await pending).toMatchObject({ status: 'error', code: 'stale-context' })
    finishRemoval()
    await removal
  })
})
