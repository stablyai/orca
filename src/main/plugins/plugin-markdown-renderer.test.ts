import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type {
  PluginMarkdownRenderRequest,
  PluginMarkdownWorkerResult
} from '../../shared/plugins/plugin-markdown-renderer'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginMarkdownRenderer } from './plugin-markdown-renderer'

function provider(id = 'notes'): ValidDiscoveredPlugin {
  return {
    pluginKey: `orca-samples.${id}`,
    rootDir: '/fixture',
    contentHash: null,
    isDev: true,
    consentFingerprint: 'reviewed',
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      publisher: 'orca-samples',
      id,
      name: 'Notes',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'worker.mjs',
      contributes: {
        commands: [{ id: 'render-dataview', title: 'Render' }],
        markdownRenderers: [{ language: 'dataview', commandId: 'render-dataview' }]
      }
    })
  }
}

const request: PluginMarkdownRenderRequest = {
  language: 'dataview',
  code: 'LIST',
  sessionId: 'block',
  knownRevision: 'r0',
  source: {
    runtimeId: 'runtime',
    worktreeId: 'folder:notes',
    fileId: 'file',
    documentPath: '/notes/a.md',
    workspacePath: '/notes'
  }
}
const result: PluginMarkdownWorkerResult = {
  sessionId: 'block',
  revision: 'r1',
  output: { kind: 'list', items: [{ text: 'A' }] }
}

function harness() {
  let plugins = [provider()]
  let enabled = true
  const invoke = vi
    .fn<(key: string, command: string, args: unknown) => Promise<unknown>>()
    .mockResolvedValue(result)
  const resolveSource = vi.fn(async () => ({ status: 'resolved' as const, source: request.source }))
  const controller = new PluginMarkdownRenderer({
    plugins: () => plugins,
    available: () => enabled,
    invoke,
    resolveSource
  })
  return {
    controller,
    invoke,
    resolveSource,
    setPlugins: (value: ValidDiscoveredPlugin[]) => {
      plugins = value
    },
    disable: () => {
      enabled = false
    }
  }
}

describe('native Markdown provider boundary', () => {
  it('passes the exact validated request through the existing declared command', async () => {
    const h = harness()
    expect(h.controller.list()).toEqual([
      { language: 'dataview', pluginKey: 'orca-samples.notes', available: true }
    ])
    expect(await h.controller.render('renderer:1', request)).toEqual({
      status: 'rendered',
      pluginKey: 'orca-samples.notes',
      ...result
    })
    expect(h.invoke).toHaveBeenCalledWith('orca-samples.notes', 'render-dataview', request)
  })

  it('distinguishes missing, disabled and colliding providers without invoking any', async () => {
    const h = harness()
    h.setPlugins([])
    expect(await h.controller.render('owner', request)).toEqual({
      status: 'unavailable',
      reason: 'missing-provider'
    })
    h.setPlugins([provider(), provider('other')])
    expect(h.controller.list().every((entry) => !entry.available)).toBe(true)
    expect(await h.controller.render('owner', request)).toEqual({
      status: 'unavailable',
      reason: 'ambiguous-provider'
    })
    h.setPlugins([provider()])
    h.disable()
    expect(await h.controller.render('owner', request)).toEqual({
      status: 'unavailable',
      reason: 'disabled-provider'
    })
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('refuses malformed requests and mismatched runtime or workspace identity', async () => {
    const h = harness()
    expect(
      await h.controller.render('owner', { ...request, code: 'x'.repeat(65537) })
    ).toMatchObject({ status: 'error', code: 'invalid-request' })
    expect(
      await h.controller.render('owner', {
        ...request,
        source: { ...request.source, runtimeId: 'other' }
      })
    ).toEqual({ status: 'unavailable', reason: 'unsupported-context' })
    expect(
      await h.controller.render('owner', {
        ...request,
        source: { ...request.source, workspacePath: '/other' }
      })
    ).toEqual({ status: 'unavailable', reason: 'unsupported-context' })
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it.each([
    { ...result, sessionId: 'other' },
    { ...result, output: { kind: 'html', html: '<b>A</b>' } },
    { ...result, output: { kind: 'table', columns: ['A'], rows: [[]] } },
    {
      ...result,
      output: {
        kind: 'list',
        items: [{ text: 'A', reference: { path: '../escape.md', base: 'workspace' } }]
      }
    },
    {
      ...result,
      output: {
        kind: 'list',
        items: Array.from({ length: 200 }, () => ({ text: 'x'.repeat(4096) }))
      }
    }
  ])('rejects invalid or excessive output %#', async (output) => {
    const h = harness()
    h.invoke.mockResolvedValue(output)
    expect(await h.controller.render('owner', request)).toMatchObject({
      status: 'error',
      code: 'invalid-output'
    })
  })

  it('bounds and sanitizes worker failures', async () => {
    const h = harness()
    h.invoke.mockRejectedValue(new Error('private worker details'))
    expect(await h.controller.render('owner', request)).toEqual({
      status: 'error',
      code: 'provider-error',
      message: 'The plugin could not render this block.'
    })
  })

  it('counts repeated objects in the serialized output budget', async () => {
    const h = harness()
    const cell = { text: 'x'.repeat(4096) }
    h.invoke.mockResolvedValue({
      ...result,
      output: { kind: 'list', items: Array.from({ length: 200 }, () => cell) }
    })
    expect(await h.controller.render('owner', request)).toMatchObject({
      status: 'error',
      code: 'invalid-output'
    })
  })

  it('revalidates source runtime and root after the worker returns', async () => {
    const h = harness()
    h.resolveSource.mockResolvedValueOnce({ status: 'resolved', source: request.source })
    h.resolveSource.mockResolvedValueOnce({
      status: 'resolved',
      source: { ...request.source, runtimeId: 'new-runtime' }
    })
    expect(await h.controller.render('owner', request)).toMatchObject({
      status: 'error',
      code: 'stale-context'
    })
  })

  it('fences cancellation by owner and rejects disabled providers after an await', async () => {
    const h = harness()
    let finish: (value: unknown) => void = () => undefined
    h.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = h.controller.render('owner', request)
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))
    h.controller.cancel('different-owner', { sessionId: 'block' })
    finish(result)
    expect(await pending).toMatchObject({ status: 'rendered' })
    const cancelled = h.controller.render('owner', request)
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2))
    h.controller.cancel('owner', { sessionId: 'block' })
    finish(result)
    expect(await cancelled).toMatchObject({ status: 'error', code: 'stale-context' })
    const disabled = h.controller.render('owner', request)
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(3))
    h.disable()
    finish(result)
    expect(await disabled).toMatchObject({ status: 'error', code: 'stale-context' })
  })

  it('fences superseded requests, replaced providers and destroyed renderer owners', async () => {
    const h = harness()
    const finishes: ((value: unknown) => void)[] = []
    h.invoke.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)))
    const first = h.controller.render('owner', request)
    await vi.waitFor(() => expect(finishes).toHaveLength(1))
    const next = h.controller.render('owner', request)
    await vi.waitFor(() => expect(finishes).toHaveLength(2))
    finishes[0]!(result)
    expect(await first).toMatchObject({ code: 'stale-context' })
    h.controller.revokeOwner('owner')
    finishes[1]!(result)
    expect(await next).toMatchObject({ code: 'stale-context' })
    const replaced = h.controller.render('owner', request)
    await vi.waitFor(() => expect(finishes).toHaveLength(3))
    h.setPlugins([provider()])
    finishes[2]!(result)
    expect(await replaced).toMatchObject({ code: 'stale-context' })
  })

  it('bounds concurrent work even when owners cancel pending replies', async () => {
    const h = harness()
    const finishes: ((value: unknown) => void)[] = []
    h.invoke.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)))
    const pending = Array.from({ length: 4 }, (_, index) =>
      h.controller.render(`owner-${index}`, request)
    )
    await vi.waitFor(() => expect(finishes).toHaveLength(4))
    h.controller.cancel('owner-0', { sessionId: 'block' })
    expect(await h.controller.render('owner-5', request)).toMatchObject({ code: 'provider-error' })
    finishes.forEach((finish) => finish(result))
    await Promise.all(pending)
    h.invoke.mockResolvedValue(result)
    expect(await h.controller.render('owner', request)).toMatchObject({ status: 'rendered' })
  })
})
