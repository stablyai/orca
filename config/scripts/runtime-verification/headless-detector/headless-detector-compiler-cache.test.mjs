import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  activateCompilerCache,
  compilerCacheIdentity,
  packCompilerCache
} from './headless-detector-compiler-cache.mjs'

const temporary = []
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'headless-compiler-cache-'))
  temporary.push(directory)
  const root = join(directory, 'checkout')
  mkdirSync(root)
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  const identity = compilerCacheIdentity({ policyHash: 'policy', cacheRoot: directory })
  packCompilerCache({ identity })
  return { root, identity }
}

it.each(['modified', 'missing', 'extra', 'symlink', 'malformed'])(
  'falls back on %s cache contents before loading code',
  async (kind) => {
    const { root, identity } = fixture()
    const compiler = join(identity.path, 'node_modules', 'esbuild', 'lib', 'main.js')
    if (kind === 'modified') {
      appendFileSync(compiler, '\nthrow Error("must not load")')
    }
    if (kind === 'missing') {
      rmSync(compiler)
    }
    if (kind === 'extra') {
      writeFileSync(join(identity.path, 'unexpected'), 'extra')
    }
    if (kind === 'symlink') {
      rmSync(compiler)
      symlinkSync(join(root, 'package.json'), compiler)
    }
    if (kind === 'malformed') {
      writeFileSync(join(identity.path, 'manifest.json'), '{')
    }
    expect((await activateCompilerCache({ root, identity })).available).toBe(false)
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
  }
)

it('leaves existing dependencies alone and falls back on an absent archive', async () => {
  const { root, identity } = fixture()
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'retained'), 'retained')
  expect((await activateCompilerCache({ root, identity })).available).toBe(false)
  expect(readFileSync(join(root, 'node_modules', 'retained'), 'utf8')).toBe('retained')
  rmSync(join(root, 'node_modules'), { recursive: true })
  rmSync(identity.path, { recursive: true })
  expect((await activateCompilerCache({ root, identity })).available).toBe(false)
  expect(existsSync(join(root, 'node_modules'))).toBe(false)
})
