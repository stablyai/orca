import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPluginEditors } from './plugin-editor-check'
import { createPluginFromTemplate } from './plugin-create'
import { validatePluginTarget } from './plugin-folder-validation'
import { checkPluginDevFolder } from '../dev-watch/plugin-dev-watch-check'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The editor template behind an HTML page that loads `editor/main.ts`, which imports `./sync.ts`. */
async function editorPlugin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-editor-check-'))
  roots.push(root)
  const dir = join(root, 'notes')
  await createPluginFromTemplate({ dir, template: 'editor', publisher: 'acme' })
  await writeFile(
    join(dir, 'editor', 'index.html'),
    '<!doctype html>\n<html>\n<body>\n<script type="module" src="./main.ts"></script>\n</body>\n</html>\n'
  )
  const manifestPath = join(dir, 'orca-plugin.json')
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, 'utf8')).replace('editor/main.ts', 'editor/index.html')
  )
  await writeFile(
    join(dir, 'editor', 'main.ts'),
    "import { start } from './sync'\nconst text: string = 'a'\nstart(text)\n"
  )
  await writeFile(join(dir, 'editor', 'sync.ts'), 'export function start(text: string): void {}\n')
  return dir
}

describe('orca plugin check: custom editors', () => {
  it('fails on a syntax error that validate lets through', async () => {
    const dir = await editorPlugin()
    await appendFile(join(dir, 'editor', 'main.ts'), 'this is not valid ts(\n')
    expect((await validatePluginTarget(dir)).valid).toBe(true)
    const [check] = await checkPluginEditors(dir)
    expect(check.issues).toEqual([
      expect.objectContaining({ code: 'editor_syntax', location: 'editor/main.ts:4:6' })
    ])
  })

  it('reports missing files and refused imports, and warns on string eval', async () => {
    const dir = await editorPlugin()
    await writeFile(
      join(dir, 'editor', 'main.ts'),
      [
        "import './gone'",
        "import 'left-pad'",
        '// eval("comments do not count")',
        "const label = 'new Function in a string does not count'",
        "eval('1')",
        "const f = new Function('return 1')",
        ''
      ].join('\n')
    )
    const [check] = await checkPluginEditors(dir)
    expect(check.issues.map(({ code, location }) => [code, location])).toEqual([
      ['editor_import', 'editor/main.ts:1:9'],
      ['editor_import', 'editor/main.ts:2:9']
    ])
    // A lexical scan can misread code, so eval is a warning that does not fail the check.
    expect(check.warnings.map(({ code, location }) => [code, location])).toEqual([
      ['editor_eval', 'editor/main.ts:5:1'],
      ['editor_eval', 'editor/main.ts:6:11']
    ])
  })

  it('reports a missing script, a broken inline script, and a script over 16 MiB', async () => {
    const dir = await editorPlugin()
    const html = join(dir, 'editor', 'index.html')
    await writeFile(
      html,
      [
        '<body>',
        '<script src="./absent.js"></script>',
        '<script type="module" src="./big.js"></script>',
        '<script>',
        'const x = (',
        '</script>',
        '</body>'
      ].join('\n')
    )
    await mkdir(join(dir, 'editor'), { recursive: true })
    await writeFile(join(dir, 'editor', 'big.js'), 'x'.repeat(16 * 1024 * 1024 + 1))
    const [check] = await checkPluginEditors(dir)
    expect(check.issues.map(({ code, location }) => [code, location])).toEqual([
      ['editor_syntax', 'editor/index.html:6:1'],
      ['editor_missing_file', 'editor/index.html:2:1'],
      ['editor_too_large', 'editor/index.html:3:1']
    ])
  })

  it('caps a transpiled source module at 1 MiB', async () => {
    const dir = await editorPlugin()
    await writeFile(join(dir, 'editor', 'sync.ts'), `// ${'x'.repeat(1024 * 1024)}\n`)
    const [check] = await checkPluginEditors(dir)
    expect(check.issues).toEqual([
      expect.objectContaining({ code: 'editor_too_large', location: 'editor/main.ts:1:24' })
    ])
  })

  it('fails dev watch --check on an editor issue, and passes it with only a warning', async () => {
    const dir = await editorPlugin()
    await appendFile(join(dir, 'editor', 'main.ts'), "eval('1')\n")
    const warned = await checkPluginDevFolder(dir)
    expect(warned.ok).toBe(true)
    expect(warned.editors[0]?.warnings).toEqual([expect.objectContaining({ code: 'editor_eval' })])
    await appendFile(join(dir, 'editor', 'main.ts'), 'this is not valid ts(\n')
    const failed = await checkPluginDevFolder(dir)
    expect(failed.ok).toBe(false)
    expect(failed.editors[0]?.issues).toEqual([expect.objectContaining({ code: 'editor_syntax' })])
  })
})
