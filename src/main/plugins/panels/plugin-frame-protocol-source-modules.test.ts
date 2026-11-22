import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { pluginFrameKey } from '../../../shared/plugins/frames/plugin-frame-guest'
import { PLUGIN_SOURCE_MODULES_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'
import { hashPluginTree } from '../artifacts/plugin-content-hash'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { createPluginFrameRequestHandler } from './plugin-frame-protocol'
import {
  PLUGIN_FRAME_MAX_IN_FLIGHT,
  PLUGIN_FRAME_MAX_QUEUED,
  PLUGIN_FRAME_MAX_STREAMS,
  PLUGIN_FRAME_MAX_WAIT_MS
} from './frame-serving/plugin-frame-admission'
import { verifyPluginFrameTree } from './frame-serving/plugin-frame-integrity'
import { createPluginSourceModuleCompiler } from './frame-serving/plugin-frame-module-transform'
import { transpilePluginSource } from './source-transpilation/plugin-source-transpiler'

const PLUGIN_KEY = 'acme.todos'
const KEY = pluginFrameKey(PLUGIN_KEY)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { installed: boolean }): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-frame-source-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'src'), { recursive: true })
  await writeFile(
    join(rootDir, 'src', 'panel.tsx'),
    "import { Text } from 'orca'\nimport { label } from './label'\nexport default () => <Text>{label}</Text>\n"
  )
  await writeFile(join(rootDir, 'src', 'label.ts'), "export const label: string = 'hi'\n")
  await writeFile(join(rootDir, 'src', 'page.ts'), "document.body.append('page')\n")
  await writeFile(join(rootDir, 'src', 'clip.mp4'), Buffer.alloc(1024))
  const tree = await hashPluginTree(rootDir)
  return {
    pluginKey: PLUGIN_KEY,
    rootDir,
    contentHash: options.installed && tree.ok ? tree.hash : null,
    consentFingerprint: 'approved',
    isDev: !options.installed,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'todos',
      name: 'Todos',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_SOURCE_MODULES_SINCE}` },
      pluginApi: 1,
      contributes: {
        panels: [
          { id: 'todos', title: 'Todos', entry: 'src/panel.tsx', ui: 'components' },
          { id: 'page', title: 'Page', entry: 'src/page.ts' }
        ]
      }
    })
  }
}

function handlerFor(plugin: ValidDiscoveredPlugin) {
  const log = vi.fn()
  const handle = createPluginFrameRequestHandler(
    {
      findApprovedPluginByFrameKey: () => plugin,
      verifyTree: verifyPluginFrameTree,
      log,
      // In process: built worker entries do not exist under vitest.
      compileSourceModule: createPluginSourceModuleCompiler({
        transpile: async (path, source) => transpilePluginSource(path, source)
      })
    },
    KEY
  )
  return { handle, log }
}

const url = (path: string) => `orca-plugin-frame://${KEY}/${path}`

describe('orca-plugin-frame source modules', () => {
  it.each([false, true])('serves TSX as JavaScript (installed: %s)', async (installed) => {
    const { handle } = handlerFor(await fixture({ installed }))
    const response = await handle(new Request(url('src/panel.tsx')))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    const code = await response.text()
    expect(code).toContain('from "orca/jsx-runtime"')
    expect(code).toContain("from './label.ts'")
    expect(code).toContain('sourceMappingURL=data:application/json')
  })

  it('serves a generated page for a TS frame entry, and the module for its script', async () => {
    const { handle } = handlerFor(await fixture({ installed: true }))
    const page = await handle(new Request(`${url('src/page.ts')}?rev=dev`))
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toContain(
      '<script type="module" src="./page.ts?orca-module"></script>'
    )
    const script = await handle(new Request(`${url('src/page.ts')}?orca-module`))
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(await script.text()).toContain("document.body.append('page')")
  })
})

describe('orca-plugin-frame admission', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function blockedHandler(): Promise<{
    handle: (request: Request) => Promise<Response>
    log: ReturnType<typeof vi.fn>
    compiling: () => number
    peak: () => number
    unblock: () => void
  }> {
    const plugin = await fixture({ installed: false })
    let compiling = 0
    let peak = 0
    let unblock = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const log = vi.fn()
    const handle = createPluginFrameRequestHandler(
      {
        findApprovedPluginByFrameKey: () => plugin,
        verifyTree: verifyPluginFrameTree,
        log,
        compileSourceModule: async () => {
          compiling += 1
          peak = Math.max(peak, compiling)
          await blocked
          compiling -= 1
          return 'export {}'
        }
      },
      KEY
    )
    return { handle, log, compiling: () => compiling, peak: () => peak, unblock }
  }

  it('serves a burst up to the queue bound at the in-flight cap and refuses past it, logged once', async () => {
    const frame = await blockedHandler()
    const width = PLUGIN_FRAME_MAX_IN_FLIGHT + PLUGIN_FRAME_MAX_QUEUED
    const responses = Array.from({ length: width }, () =>
      frame.handle(new Request(url('src/label.ts')))
    )
    await vi.waitFor(() => expect(frame.compiling()).toBe(PLUGIN_FRAME_MAX_IN_FLIGHT))
    const refused = await Promise.all([
      frame.handle(new Request(url('src/label.ts'))),
      frame.handle(new Request(url('src/label.ts')))
    ])
    expect(refused.map((response) => response.status)).toEqual([503, 503])
    expect(frame.log).toHaveBeenCalledTimes(1)
    expect(frame.log).toHaveBeenCalledWith(PLUGIN_KEY, expect.stringContaining('src/label.ts busy'))
    frame.unblock()
    const statuses = await Promise.all(responses.map(async (r) => (await r).status))
    expect(statuses.every((status) => status === 200)).toBe(true)
    expect(frame.peak()).toBe(PLUGIN_FRAME_MAX_IN_FLIGHT)
  })

  it('refuses streams past their own cap at once without holding up scripts', async () => {
    const frame = await blockedHandler()
    frame.unblock()
    const held = await Promise.all(
      Array.from({ length: PLUGIN_FRAME_MAX_STREAMS }, () =>
        frame.handle(new Request(url('src/clip.mp4')))
      )
    )
    expect(held.every((response) => response.status === 200)).toBe(true)
    expect((await frame.handle(new Request(url('src/clip.mp4')))).status).toBe(503)
    expect(frame.log).toHaveBeenCalledWith(PLUGIN_KEY, expect.stringContaining('streams open'))
    expect((await frame.handle(new Request(url('src/label.ts')))).status).toBe(200)
    await held[0].body?.cancel()
    expect((await frame.handle(new Request(url('src/clip.mp4')))).status).toBe(200)
    await Promise.all(held.slice(1).map((response) => response.body?.cancel()))
  })

  it('refuses a request that waits too long for a slot held open, logged despite open streams', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frame = await blockedHandler()
    const streams = await Promise.all(
      Array.from({ length: PLUGIN_FRAME_MAX_STREAMS + 1 }, () =>
        frame.handle(new Request(url('src/clip.mp4')))
      )
    )
    expect(frame.log).toHaveBeenCalledWith(PLUGIN_KEY, expect.stringContaining('streams open'))
    const held = Array.from({ length: PLUGIN_FRAME_MAX_IN_FLIGHT }, () =>
      frame.handle(new Request(url('src/label.ts')))
    )
    await vi.waitFor(() => expect(frame.compiling()).toBe(PLUGIN_FRAME_MAX_IN_FLIGHT))
    const waiting = frame.handle(new Request(url('src/label.ts')))
    vi.advanceTimersByTime(PLUGIN_FRAME_MAX_WAIT_MS)
    expect((await waiting).status).toBe(503)
    expect(frame.log).toHaveBeenCalledWith(PLUGIN_KEY, expect.stringContaining('busy: waited'))
    frame.unblock()
    await Promise.all(held)
    await Promise.all(streams.map((response) => response.body?.cancel()))
  })
})
