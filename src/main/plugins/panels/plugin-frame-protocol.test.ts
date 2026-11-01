import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { pluginFrameKey } from '../../../shared/plugins/frames/plugin-frame-guest'
import { PLUGIN_GUEST_CSP } from '../../../shared/plugins/frames/plugin-panel-shell'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { createPluginFrameRequestHandler } from './plugin-frame-protocol'
import { PLUGIN_PANEL_UI_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'

const PLUGIN_KEY = 'acme.charts'
const KEY = pluginFrameKey(PLUGIN_KEY)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<ValidDiscoveredPlugin> {
  const base = await mkdtemp(join(tmpdir(), 'orca-frame-protocol-'))
  roots.push(base)
  const rootDir = join(base, 'plugin')
  await mkdir(join(rootDir, 'lib'), { recursive: true })
  await writeFile(
    join(rootDir, 'panel.html'),
    '<body><h1>Charts</h1><script src="lib/app.js"></script></body>'
  )
  await writeFile(join(rootDir, 'editor.html'), '<body>editor</body>')
  await writeFile(join(rootDir, 'lib', 'app.js'), 'console.log(1)')
  await writeFile(join(rootDir, 'lib', 'mod.wasm'), Buffer.from([0, 97, 115, 109]))
  await writeFile(join(base, 'secret.txt'), 'outside')
  await symlink(join(base, 'secret.txt'), join(rootDir, 'escape.txt'))
  return {
    pluginKey: PLUGIN_KEY,
    rootDir,
    contentHash: null,
    consentFingerprint: 'approved',
    isDev: true,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'charts',
      publisher: 'acme',
      name: 'Charts',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_PANEL_UI_SINCE}` },
      pluginApi: 1,
      contributes: {
        panels: [
          { id: 'panel', title: 'Charts', entry: 'panel.html' },
          { id: 'todos', title: 'Todos', entry: 'lib/app.js', ui: 'components' }
        ],
        customEditors: [{ id: 'csv', title: 'CSV', extensions: ['.csv'], entry: 'editor.html' }]
      }
    })
  }
}

function handlerFor(
  plugin: ValidDiscoveredPlugin | null,
  verify = vi.fn(async (): Promise<ReadonlyMap<string, string> | null> => null)
) {
  const log = vi.fn()
  const handle = createPluginFrameRequestHandler(
    {
      findApprovedPluginByFrameKey: (frameKey) => (frameKey === KEY ? plugin : null),
      verifyTree: verify,
      log,
      readDeclarativeRuntime: async () => new TextEncoder().encode('export const h = 1')
    },
    KEY
  )
  return { handle, verify, log }
}

const get = (url: string, method = 'GET') => new Request(url, { method })

describe('orca-plugin-frame protocol', () => {
  it('serves assets with their type, the guest CSP and no caching', async () => {
    const { handle, verify } = handlerFor(await fixture())
    const script = await handle(get(`orca-plugin-frame://${KEY}/lib/app.js`))
    expect(script.status).toBe(200)
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('Content-Security-Policy')).toBe(PLUGIN_GUEST_CSP)
    expect(script.headers.get('Cache-Control')).toBe('no-store')
    expect(script.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await script.text()).toBe('console.log(1)')
    const wasm = await handle(get(`orca-plugin-frame://${KEY}/lib/mod.wasm`))
    expect(wasm.headers.get('Content-Type')).toBe('application/wasm')
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]))
    // The second asset rides the first one's fresh verification.
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('re-verifies on navigation at most every 2 s, and assets or fetches once stale', async () => {
    const plugin = await fixture()
    let clock = 0
    const verify = vi.fn(async () => null)
    const handle = createPluginFrameRequestHandler(
      {
        findApprovedPluginByFrameKey: () => plugin,
        verifyTree: verify,
        now: () => clock
      },
      KEY
    )
    const navigate = (path: string) =>
      new Request(`orca-plugin-frame://${KEY}/${path}`, {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
      })
    await handle(navigate('panel.html'))
    expect(verify).toHaveBeenCalledTimes(1)
    // A fetch('/panel.html') loop is an asset request and rides the last check.
    for (let i = 0; i < 20; i += 1) {
      await handle(get(`orca-plugin-frame://${KEY}/panel.html`))
    }
    await handle(navigate('panel.html'))
    expect(verify).toHaveBeenCalledTimes(1)
    clock = 2_000
    await handle(navigate('panel.html'))
    await handle(get(`orca-plugin-frame://${KEY}/lib/app.js`))
    expect(verify).toHaveBeenCalledTimes(2)
    clock = 12_000
    await handle(get(`orca-plugin-frame://${KEY}/lib/app.js`))
    expect(verify).toHaveBeenCalledTimes(3)
  })

  it('wraps HTML documents in the guest shell, with the editor API only for editor entries', async () => {
    const { handle } = handlerFor(await fixture())
    const panel = await (await handle(get(`orca-plugin-frame://${KEY}/panel.html`))).text()
    expect(panel).toContain('__orcaPluginFrameTransport')
    expect(panel).toContain('"surface":"panel"')
    expect(panel).toContain('<h1>Charts</h1>')
    expect(panel.indexOf('__orcaPluginFrameTransport')).toBeLessThan(panel.indexOf('<h1>'))
    const editor = await (await handle(get(`orca-plugin-frame://${KEY}/editor.html`))).text()
    expect(editor).toContain('"surface":"editor"')
  })

  it('bakes the current host theme into documents', async () => {
    const plugin = await fixture()
    const handle = createPluginFrameRequestHandler(
      {
        findApprovedPluginByFrameKey: () => plugin,
        verifyTree: async () => null,
        currentTheme: () => ({ colorScheme: 'light', tokens: '--orca-primary:red' })
      },
      KEY
    )
    const html = await (await handle(get(`orca-plugin-frame://${KEY}/panel.html`))).text()
    expect(html).toContain('<html class="light">')
    expect(html).toContain(':root{--orca-primary:red}')
  })

  it('serves one byte range for media seeking', async () => {
    const plugin = await fixture()
    await writeFile(join(plugin.rootDir, 'clip.mp4'), 'console.log(1)')
    const { handle } = handlerFor(plugin)
    const partial = await handle(
      new Request(`orca-plugin-frame://${KEY}/clip.mp4`, { headers: { range: 'bytes=2-5' } })
    )
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-5/14')
    expect(await partial.text()).toBe('nsol')
    const tail = await handle(
      new Request(`orca-plugin-frame://${KEY}/clip.mp4`, { headers: { range: 'bytes=-3' } })
    )
    expect(await tail.text()).toBe('(1)')
    const whole = await handle(
      new Request(`orca-plugin-frame://${KEY}/clip.mp4`, { headers: { range: 'bytes=99-' } })
    )
    expect(whole.status).toBe(200)
  })

  it('answers HEAD without a body', async () => {
    const { handle } = handlerFor(await fixture())
    const head = await handle(get(`orca-plugin-frame://${KEY}/lib/app.js`, 'HEAD'))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it.each([
    [`orca-plugin-frame://${KEY}/escape.txt`, 'symlink out of the root'],
    [`orca-plugin-frame://${KEY}/..%2Fsecret.txt`, 'encoded traversal'],
    [`orca-plugin-frame://${KEY}/__orca/panel.html`, 'reserved prefix'],
    [`orca-plugin-frame://${KEY}/__ORCA/panel.html`, 'reserved prefix, any case'],
    [`orca-plugin-frame://${KEY}/missing.js`, 'missing file'],
    [`orca-plugin-frame://${KEY}/lib`, 'directory'],
    [`orca-plugin-frame://${pluginFrameKey('acme.other')}/panel.html`, "another plugin's origin"]
  ])('404s %s (%s)', async (url) => {
    const { handle } = handlerFor(await fixture())
    expect((await handle(get(url))).status).toBe(404)
  })

  it('404s plugins that are no longer approved and trees that fail integrity', async () => {
    expect(
      (await handlerFor(null).handle(get(`orca-plugin-frame://${KEY}/panel.html`))).status
    ).toBe(404)
    const tampered = handlerFor(
      await fixture(),
      vi.fn(async (): Promise<ReadonlyMap<string, string> | null> => {
        throw new Error('content hash mismatch')
      })
    )
    expect((await tampered.handle(get(`orca-plugin-frame://${KEY}/panel.html`))).status).toBe(404)
    expect(tampered.log).toHaveBeenCalledWith(PLUGIN_KEY, expect.stringContaining('content hash'))
  })

  it('refuses methods other than GET and HEAD', async () => {
    const { handle } = handlerFor(await fixture())
    expect((await handle(get(`orca-plugin-frame://${KEY}/panel.html`, 'POST'))).status).toBe(405)
  })

  it("serves Orca's declarative host page only for a declared declarative entry", async () => {
    const { handle } = handlerFor(await fixture())
    const page = await handle(
      get(`orca-plugin-frame://${KEY}/__orca/declarative-host.html?entry=lib%2Fapp.js`)
    )
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('"orca":"/__orca/orca-runtime.mjs"')
    expect(html).toContain('"/lib/app.js"')
    expect(html).toContain('__orcaDeclarativePost')
    for (const entry of ['panel.html', '..%2Fsecret.txt', 'https%3A%2F%2Fexample.com%2Fx.js', '']) {
      const refused = await handle(
        get(`orca-plugin-frame://${KEY}/__orca/declarative-host.html?entry=${entry}`)
      )
      expect(refused.status).toBe(404)
    }
    const runtime = await handle(get(`orca-plugin-frame://${KEY}/__orca/orca-runtime.mjs`))
    expect(runtime.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(await runtime.text()).toBe('export const h = 1')
  })

  it('serves only the bytes the verified tree covered for code and documents', async () => {
    const plugin = await fixture()
    const { createHash } = await import('node:crypto')
    const digest = (text: string) => createHash('sha256').update(text).digest('hex')
    const digests = new Map([
      ['lib/app.js', digest('console.log(1)')],
      ['panel.html', 'stale']
    ])
    const { handle } = handlerFor(
      plugin,
      vi.fn(async () => digests)
    )
    expect((await handle(get(`orca-plugin-frame://${KEY}/lib/app.js`))).status).toBe(200)
    expect((await handle(get(`orca-plugin-frame://${KEY}/panel.html`))).status).toBe(404)
    // A file added after verification has no digest at all.
    expect((await handle(get(`orca-plugin-frame://${KEY}/editor.html`))).status).toBe(404)
  })

  it('serves a declared entry without an extension as an HTML document', async () => {
    const plugin = await fixture()
    await writeFile(join(plugin.rootDir, 'dist-panel'), '<p>bare</p>')
    const bare = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        contributes: {
          ...plugin.manifest.contributes,
          panels: [{ id: 'bare', title: 'Bare', entry: 'dist-panel' }]
        }
      }
    }
    const response = await handlerFor(bare).handle(get(`orca-plugin-frame://${KEY}/dist-panel`))
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toContain('__orcaPluginFrameTransport')
  })

  it('streams media, answers HEAD from stat, and refuses past the in-flight cap', async () => {
    const plugin = await fixture()
    await writeFile(join(plugin.rootDir, 'clip.mp4'), Buffer.alloc(256 * 1024, 7))
    const { handle } = handlerFor(plugin)
    const head = await handle(get(`orca-plugin-frame://${KEY}/clip.mp4`, 'HEAD'))
    expect(head.headers.get('Content-Length')).toBe(String(256 * 1024))
    expect(await head.text()).toBe('')
    const open = await Promise.all(
      Array.from({ length: 32 }, () => handle(get(`orca-plugin-frame://${KEY}/clip.mp4`)))
    )
    expect(open.every((response) => response.status === 200)).toBe(true)
    expect((await handle(get(`orca-plugin-frame://${KEY}/clip.mp4`))).status).toBe(503)
    const first = await open[0]!.arrayBuffer()
    expect(first.byteLength).toBe(256 * 1024)
    // Finishing a stream frees its slot.
    expect((await handle(get(`orca-plugin-frame://${KEY}/lib/app.js`))).status).toBe(200)
    await Promise.all(open.slice(1).map((response) => response.body?.cancel()))
  })
})
