import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')

function inventory(directory, prefix = '') {
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error('Compiler cache directory is a symlink')
  }
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name)
      const file = `${prefix}${name}`
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        throw new Error('Compiler cache contains a symlink')
      }
      if (stat.isDirectory()) {
        return inventory(path, `${file}/`)
      }
      if (!stat.isFile()) {
        throw new Error('Compiler cache contains a special file')
      }
      return [{ file, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }]
    })
    .sort((a, b) => a.file.localeCompare(b.file))
}

export function compilerCacheIdentity({
  policyHash = process.env.COMPILER_POLICY_HASH,
  cacheRoot = process.env.RUNNER_TEMP,
  platform = process.platform,
  arch = process.arch,
  node = process.version
} = {}) {
  if (!policyHash || !cacheRoot) {
    throw new Error('Compiler cache requires policy hash and cache root')
  }
  return {
    key: `headless-compiler-v1-${platform}-${arch}-${node}-${policyHash}`,
    path: join(cacheRoot, 'headless-detector-compiler')
  }
}

export function packCompilerCache({ root = ROOT, identity = compilerCacheIdentity() } = {}) {
  const require = createRequire(join(root, 'package.json'))
  const esbuildDir = dirname(require.resolve('esbuild/package.json'))
  const nativeName = `@esbuild/${process.platform}-${process.arch}`
  const nativeDir = dirname(require.resolve(`${nativeName}/package.json`, { paths: [esbuildDir] }))
  rmSync(identity.path, { recursive: true, force: true })
  mkdirSync(join(identity.path, 'node_modules', '@esbuild'), { recursive: true })
  cpSync(esbuildDir, join(identity.path, 'node_modules', 'esbuild'), {
    recursive: true,
    dereference: true
  })
  cpSync(nativeDir, join(identity.path, 'node_modules', nativeName), {
    recursive: true,
    dereference: true
  })
  writeFileSync(
    join(identity.path, 'manifest.json'),
    JSON.stringify({
      key: identity.key,
      node: process.version,
      version: require('esbuild').version,
      files: inventory(identity.path)
    })
  )
}

export async function activateCompilerCache({
  root = ROOT,
  identity = compilerCacheIdentity()
} = {}) {
  const dependencies = join(root, 'node_modules')
  let created = false
  try {
    if (existsSync(dependencies)) {
      throw new Error('Compiler activation requires an empty dependency tree')
    }
    const files = inventory(identity.path).filter((row) => row.file !== 'manifest.json')
    const manifest = JSON.parse(readFileSync(join(identity.path, 'manifest.json'), 'utf8'))
    if (
      manifest.key !== identity.key ||
      manifest.node !== process.version ||
      JSON.stringify(files) !== JSON.stringify(manifest.files)
    ) {
      throw new Error('Compiler cache identity or contents differ')
    }
    mkdirSync(join(dependencies, '@esbuild'), { recursive: true })
    created = true
    for (const name of ['esbuild', `@esbuild/${process.platform}-${process.arch}`]) {
      symlinkSync(join(identity.path, 'node_modules', name), join(dependencies, name), 'dir')
    }
    const require = createRequire(join(root, 'package.json'))
    const esbuild = require('esbuild')
    if (esbuild.version !== manifest.version) {
      throw new Error('Compiler API version differs')
    }
    await esbuild.build({
      stdin: { contents: 'export const value = 1' },
      write: false,
      logLevel: 'silent'
    })
    return { available: true }
  } catch (error) {
    if (created) {
      rmSync(dependencies, { recursive: true, force: true })
    }
    return { available: false, reason: String(error) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2]
  const identity =
    phase === 'identity'
      ? compilerCacheIdentity()
      : {
          key: process.env.COMPILER_CACHE_KEY,
          path: process.env.COMPILER_CACHE_PATH
        }
  if (!identity.key || !identity.path) {
    throw new Error('Compiler cache identity required')
  }
  const output = (values) => {
    for (const [name, value] of Object.entries(values)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
    }
  }
  if (phase === 'identity') {
    output(identity)
  } else if (phase === 'pack') {
    packCompilerCache({ identity })
  } else if (phase === 'activate') {
    const result = await activateCompilerCache({ identity })
    output({ available: result.available })
    console.log(
      result.available
        ? 'Validated headless compiler cache'
        : `Use normal dependency install: ${result.reason}`
    )
  } else {
    throw new Error('Expected identity, pack, or activate')
  }
}
