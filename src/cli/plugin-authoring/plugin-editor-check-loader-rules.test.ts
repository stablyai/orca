import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPluginEditors } from './plugin-editor-check'
import { createPluginFromTemplate } from './plugin-create'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The editor template with `files` written over it (paths under the plugin, `/`-separated). */
async function editorWith(files: Record<string, string>, entry?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-editor-rules-'))
  roots.push(root)
  const dir = join(root, 'notes')
  await createPluginFromTemplate({ dir, template: 'editor', publisher: 'acme' })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, ...path.split('/'))), { recursive: true })
    await writeFile(join(dir, ...path.split('/')), text)
  }
  if (entry) {
    const manifestPath = join(dir, 'orca-plugin.json')
    const manifest = (await readFile(manifestPath, 'utf8')).replace('editor/index.html', entry)
    await writeFile(manifestPath, manifest)
  }
  return root
}

async function check(root: string) {
  const [result] = await checkPluginEditors(join(root, 'notes'))
  return result
}

const page = (body: string) => `<!doctype html><html><body>\n${body}\n</body></html>\n`

describe('orca plugin check: editors load as the frame protocol serves them', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a script a symlink takes outside the plugin',
    async () => {
      const root = await editorWith({
        'editor/index.html': page('<script src="./lib.js"></script>')
      })
      await writeFile(join(root, 'secret.js'), 'export {}')
      await symlink(join(root, 'secret.js'), join(root, 'notes', 'editor', 'lib.js'))
      const result = await check(root)
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'editor_import',
          message: expect.stringContaining('outside')
        })
      ])
    }
  )

  it('reads import maps and skips data blocks, and resolves bare native imports through the map', async () => {
    const root = await editorWith({
      'editor/index.html': page(
        [
          '<script type="importmap">{ "imports": { "lib": "./vendor/lib.js", "kit/": "./vendor/kit/" } }</script>',
          '<script type="application/json" id="config">{ "not": "javascript" }</script>',
          '<script type="module">import { a } from "lib"; import { b } from "kit/b.js"; a(b)</script>'
        ].join('\n')
      ),
      'editor/vendor/lib.js': 'export const a = (x) => x\n',
      'editor/vendor/kit/b.js': 'export const b = 1\n'
    })
    const result = await check(root)
    expect(result.issues).toEqual([])
    expect(result.files).toEqual([
      'editor/index.html',
      'editor/vendor/kit/b.js',
      'editor/vendor/lib.js'
    ])
  })

  it('refuses a bare native import the import map does not name', async () => {
    const root = await editorWith({
      'editor/index.html': page('<script type="module">import "left-pad"</script>')
    })
    expect((await check(root)).issues).toEqual([
      expect.objectContaining({
        code: 'editor_import',
        message: expect.stringContaining('import map')
      })
    ])
  })

  it('checks JSON imports as JSON and an extensionless entry as a page', async () => {
    const root = await editorWith(
      {
        'editor/page': page('<script type="module" src="./main.ts"></script>'),
        'editor/main.ts': "import data from './data.json' with { type: 'json' }\nvoid data\n",
        'editor/data.json': '{ "ok": true, }'
      },
      'editor/page'
    )
    expect((await check(root)).issues).toEqual([
      expect.objectContaining({ code: 'editor_syntax', location: 'editor/data.json:1:1' })
    ])
  })

  it('decodes an escaped script src before looking it up', async () => {
    const root = await editorWith({
      'editor/index.html': page('<script src="./my%20script.js"></script>'),
      'editor/my script.js': 'void 0\n'
    })
    const result = await check(root)
    expect(result.issues).toEqual([])
    expect(result.files).toContain('editor/my script.js')
  })

  it('lets a dependency reach the 16 MiB the protocol serves, past the 10 MiB entry cap', async () => {
    const root = await editorWith({
      'editor/index.html': page('<script type="module" src="./vendor.mjs"></script>'),
      'editor/vendor.mjs': `export const x = 1\n//${'x'.repeat(11 * 1024 * 1024)}\n`
    })
    expect((await check(root)).issues).toEqual([])
  })
})
