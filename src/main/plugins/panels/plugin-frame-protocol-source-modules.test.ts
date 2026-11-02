import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { pluginFrameKey } from '../../../shared/plugins/frames/plugin-frame-guest'
import { PLUGIN_SOURCE_MODULES_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'
import { hashPluginTree } from '../plugin-content-hash'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { createPluginFrameRequestHandler } from './plugin-frame-protocol'
import { verifyPluginFrameTree } from './plugin-frame-integrity'
import { createPluginSourceModuleCompiler } from './plugin-frame-module-transform'
import { transpilePluginSource } from './plugin-source-transpiler'

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

  it('still refuses a source file changed after the tree was verified', async () => {
    const plugin = await fixture({ installed: true })
    const { handle, log } = handlerFor(plugin)
    expect((await handle(new Request(url('src/panel.tsx')))).status).toBe(200)
    // Rides the verification above, so only the per-file digest can catch the edit.
    await writeFile(join(plugin.rootDir, 'src', 'label.ts'), "export const label = 'evil'\n")
    const response = await handle(new Request(url('src/label.ts')))
    expect(response.status).toBe(404)
    expect(log).toHaveBeenCalledWith(PLUGIN_KEY, expect.stringContaining('changed since'))
  })
})
