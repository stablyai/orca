import assert from 'node:assert/strict'
import fsPromises, { appendFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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
  return { cwd, root, git }
}

test('a scoped graph locates live imports in tracked files and resolves paths outside the requested folder', async (t) => {
  const { cwd, git } = await fixture(t)
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
  await git('add', 'src/main.mts')
  await appendFile(join(cwd, 'src', 'main.mts'), "import './types'\n")
  await writeFile(join(cwd, 'src', 'not-tracked.ts'), 'export {}\n')
  const graph = await collectCommanderCodeGraph({ cwd: join(cwd, 'src'), scope: 'src/main.mts' })
  assert.match(graph.commit, /^[a-f\d]{40,64}$/)
  assert.deepEqual(graph.edges, [
    { from: 'src/main.mts', to: 'src/types.ts', line: 2 },
    { from: 'src/main.mts', to: 'src/inner/index.ts', line: 3 },
    { from: 'src/main.mts', to: 'src/library/entry.js', line: 7 },
    ...(graph.sourceMode === 'working-tree'
      ? [{ from: 'src/main.mts', to: 'src/types.ts', line: 8 }]
      : [])
  ])
  assert.deepEqual(graph.nodes, [
    'src/main.mts',
    'src/types.ts',
    'src/inner/index.ts',
    'src/library/entry.js'
  ])
  assert.equal(graph.coverage.unresolvedRelativeImports, 1)
})

test('deep expression trees retain their import sites and a parser overflow skips only its own file', async (t) => {
  const { cwd, git } = await fixture(t)
  await writeFile(
    join(cwd, 'src', 'main.mts'),
    `const x = require('./types')${'+0'.repeat(25_000)}\nimport './inner'\n`
  )
  await writeFile(
    join(cwd, 'src', 'nested.ts'),
    `const x = ${'('.repeat(5000)}0${')'.repeat(5000)}\n`
  )
  await git('add', 'src/main.mts', 'src/nested.ts')
  const graph = await collectCommanderCodeGraph({ cwd })
  assert.deepEqual(graph.edges, [
    { from: 'src/main.mts', to: 'src/types.ts', line: 1 },
    { from: 'src/main.mts', to: 'src/inner/index.ts', line: 2 }
  ])
  assert.equal(graph.coverage.skipped, 1)
  assert.equal(graph.coverage.scanned, 4)
})

test('without opened-path verification the entire graph uses staged source and package manifests', async (t) => {
  const { cwd, git } = await fixture(t)
  const source = join(cwd, 'src', 'main.mts')
  await writeFile(source, "import './library'\n")
  await git('add', 'src/main.mts')
  await writeFile(source, "import './inner'\n")
  await writeFile(join(cwd, 'src', 'library', 'package.json'), '{}')
  const readlink = t.mock.method(fsPromises, 'readlink', async () => {
    throw new Error('Descriptor paths unavailable')
  })
  syncBuiltinESMExports()
  try {
    const graph = await collectCommanderCodeGraph({ cwd, scope: 'src/main.mts' })
    assert.equal(graph.sourceMode, 'index')
    assert.deepEqual(graph.edges, [{ from: 'src/main.mts', to: 'src/library/entry.js', line: 1 }])
  } finally {
    readlink.mock.restore()
    syncBuiltinESMExports()
  }
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
    if (result.sourceMode === 'working-tree') {
      assert.equal(result.coverage.skipped, 1)
      assert.deepEqual(result.nodes, [])
    } else {
      assert.deepEqual(result.nodes, ['src/main.mts'])
    }
    assert.deepEqual(result.edges, [])
  }
)

test('importing the graph from a client leaves CLI arguments and stdout alone', async () => {
  const url = new URL('./commander-code-graph.mjs', import.meta.url).href
  const result = await runProcess({
    program: process.execPath,
    args: ['--input-type=module', '--eval', `await import(${JSON.stringify(url)})`, '--', '--help']
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, '')
})

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
