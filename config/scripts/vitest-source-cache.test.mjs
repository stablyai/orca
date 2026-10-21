import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess, runProcessSync } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { resolvePinnedBunExecutable } from './pinned-bun-executable.mjs'
import { createSourceCachePlugin, sourceCacheIdentity } from './vitest-source-cache.mjs'

const root = process.cwd()
const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-source-cache-'))
  directories.push(directory)
  return directory
}

it('invalidates additions, deletions, package exports and compiler configuration', () => {
  const directory = fixture()
  const initial = sourceCacheIdentity(directory)
  writeFileSync(join(directory, 'source.ts'), 'export const value = 1')
  const added = sourceCacheIdentity(directory)
  expect(added).not.toBe(initial)
  writeFileSync(join(directory, 'source.ts'), 'export const value = 2')
  // Vitest hashes each source's contents itself.
  expect(sourceCacheIdentity(directory)).toBe(added)
  for (const name of ['package.json', 'tsconfig.json', 'inherited-config.json']) {
    writeFileSync(join(directory, name), '{}')
    const before = sourceCacheIdentity(directory)
    writeFileSync(join(directory, name), '{"changed":true}')
    expect(sourceCacheIdentity(directory)).not.toBe(before)
    rmSync(join(directory, name))
  }
  rmSync(join(directory, 'source.ts'))
  expect(sourceCacheIdentity(directory)).toBe(initial)
})

it('ignores generated output and dependency installations in the source inventory', () => {
  const directory = fixture()
  const initial = sourceCacheIdentity(directory)
  for (const name of ['node_modules', '.git', '.cache', 'out', 'dist', 'mobile/vendor']) {
    mkdirSync(join(directory, name), { recursive: true })
    writeFileSync(join(directory, name, 'generated.json'), '{}')
  }
  expect(sourceCacheIdentity(directory)).toBe(initial)
})

it('keys runtime defines and environment values, and bypasses persistent transforms in watch mode', () => {
  const directory = fixture()
  const plugin = createSourceCachePlugin(directory)
  let generate
  const vitest = { config: { watch: false } }
  plugin.configureVitest({
    vitest,
    defineCacheKeyGenerator: (callback) => {
      generate = callback
    }
  })
  const environment = { config: { define: { FLAG: 'true' }, env: { MODE: 'test' } } }
  const initial = generate({ environment })
  environment.config.define.FLAG = 'false'
  expect(generate({ environment })).not.toBe(initial)
  const changed = generate({ environment })
  environment.config.env.MODE = 'other'
  expect(generate({ environment })).not.toBe(changed)
  vitest.config.watch = true
  expect(generate({ environment })).toBe(false)
})

it('reuses real Vitest transforms while detecting an added higher-priority import and its removal', async () => {
  const directory = fixture()
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'junction')
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
  mkdirSync(join(directory, 'choice'))
  writeFileSync(join(directory, 'choice', 'index.ts'), 'export const value = "original"')
  writeFileSync(
    join(directory, 'choice.test.ts'),
    `import { expect, it } from 'vitest'
import { value } from './choice'
it('resolves the current source', () => expect(value).toBe(process.env.EXPECT_VALUE))
`
  )
  const pluginUrl = pathToFileURL(join(root, 'config/scripts/vitest-source-cache.mjs')).href
  writeFileSync(
    join(directory, 'vitest.config.mjs'),
    `import { createSourceCachePlugin } from ${JSON.stringify(pluginUrl)}
export default {
  plugins: [createSourceCachePlugin()],
  test: { fsModuleCache: true, fsModuleCachePath: '.cache/modules' }
}
`
  )
  const bun = resolvePinnedBunExecutable(root, runProcessSync)
  expect(bun).toBeTruthy()
  const run = async (value) => {
    const result = await runProcess({
      program: bun,
      args: ['--bun', join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=dot'],
      cwd: directory,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', EXPECT_VALUE: value },
      timeoutMs: 20_000
    })
    expect(result.code, result.stdout + result.stderr).toBe(0)
  }
  await run('original')
  const cacheDirectory = join(directory, '.cache/modules')
  const cached = readdirSync(cacheDirectory).sort()
  const timestamps = () => cached.map((name) => statSync(join(cacheDirectory, name)).mtimeMs)
  const before = timestamps()
  await run('original')
  expect(readdirSync(cacheDirectory).sort()).toEqual(cached)
  expect(timestamps()).toEqual(before)
  writeFileSync(join(directory, 'choice.ts'), 'export const value = "added"')
  await run('added')
  writeFileSync(join(directory, 'choice.ts'), 'export const value = "edited"')
  await run('edited')
  rmSync(join(directory, 'choice.ts'))
  await run('original')
  expect(readFileSync(join(directory, 'choice.test.ts'), 'utf8')).toContain("from './choice'")
}, 30_000)
