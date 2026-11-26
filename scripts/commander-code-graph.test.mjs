import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runProcess } from '@orca/process-host'
import { collectCommanderCodeGraph } from './commander-code-graph.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orca-code-graph-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'repo')
  await mkdir(join(cwd, 'src', 'inner'), { recursive: true })
  const git = async (...args) => {
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'absent.gitconfig')
    }
    const res = await runProcess({ program: 'git', cwd, args, env })
    assert.equal(res.code, 0, res.stderr)
  }
  await git('init', '--quiet')
  await writeFile(join(cwd, 'src', 'main.mts'), 'export {}\n')
  await writeFile(join(cwd, 'src', 'inner', 'index.ts'), 'export const libs = 1\n')
  await writeFile(join(cwd, 'src', 'types.ts'), 'export type Name = string\n')
  await mkdir(join(cwd, 'src', 'library'))
  await writeFile(join(cwd, 'src', 'library', 'package.json'), '{"main":"entry.js"}')
  await writeFile(join(cwd, 'src', 'library', 'entry.js'), 'export default 1\n')
  await git('add', 'src')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'initial')
  return { cwd, root }
}

test('a scoped graph locates live imports in tracked files and resolves paths outside the requested folder', async (t) => {
  const { cwd } = await fixture(t)
  await writeFile(
    join(cwd, 'src', 'main.mts'),
    [
      "// export { nope } from './typed-fake'",
      "export type { Name } from './types.js'",
      "const value = await import('./inner')",
      "require('./not-tracked')",
      "import 'external-package'",
      "loader.require('./types')",
      "const library = require('./library')",
      ''
    ].join('\n')
  )
  await writeFile(join(cwd, 'src', 'not-tracked.ts'), 'export {}\n')
  const graph = await collectCommanderCodeGraph({ cwd: join(cwd, 'src'), scope: 'src/main.mts' })
  assert.match(graph.commit, /^[a-f\d]{40,64}$/)
  assert.deepEqual(graph.edges, [
    { from: 'src/main.mts', to: 'src/types.ts', line: 2 },
    { from: 'src/main.mts', to: 'src/inner/index.ts', line: 3 },
    { from: 'src/main.mts', to: 'src/library/entry.js', line: 7 }
  ])
  assert.deepEqual(graph.nodes, [
    'src/main.mts',
    'src/types.ts',
    'src/inner/index.ts',
    'src/library/entry.js'
  ])
  assert.equal(graph.coverage.unresolvedRelativeImports, 1)
})

test('a file cap reports how much is unscanned and an escaped scope is rejected', async (t) => {
  const { cwd } = await fixture(t)
  const graph = await collectCommanderCodeGraph({ cwd, maxFiles: 1 })
  assert.equal(graph.coverage.scanned, 1)
  assert.equal(graph.coverage.remaining, 3)
  const windowsScope = await collectCommanderCodeGraph({ cwd, scope: 'src\\inner' })
  assert.deepEqual(windowsScope.nodes, ['src/inner/index.ts'])
  for (const scope of [
    'src/../../other',
    'src\\..\\other',
    'C:private',
    'C:\\private',
    '\\\\server\\share'
  ]) {
    await assert.rejects(collectCommanderCodeGraph({ cwd, scope }), /repository-relative/)
  }
})

test(
  'a tracked path replaced by a symlink never reads a file outside the checkout',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { cwd, root } = await fixture(t)
    await rm(join(cwd, 'src', 'main.mts'))
    await writeFile(join(root, 'outside'), "import './types'\n")
    await symlink(join(root, 'outside'), join(cwd, 'src', 'main.mts'))
    const result = await collectCommanderCodeGraph({ cwd, scope: 'src/main.mts' })
    assert.equal(result.coverage.skipped, 1)
    assert.deepEqual(result.nodes, [])
    assert.deepEqual(result.edges, [])
  }
)

test(
  'the executable works through a Unix bin link',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-graph-bin-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const bin = join(root, 'orca-commander-code-graph')
    await symlink(fileURLToPath(new URL('./commander-code-graph.mjs', import.meta.url)), bin)
    const result = await runProcess({ program: process.execPath, args: [bin, '--help'] })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /orca-commander-code-graph/)
  }
)
