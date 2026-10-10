import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runProcess } from '@orca/process-host'
import lockfile from 'proper-lockfile'

// Source resolution bootstraps compilation without requiring an existing dist.

const BUILD_STATE_FILE = '.dist-build-state.json'

function hashBuildInput(hash, file) {
  const contents = readFileSync(file)
  const { mtimeNs, ctimeNs, ino } = statSync(file, { bigint: true })
  // Content can change and return to its original value while the compiler reads it.
  hash
    .update(JSON.stringify([file, contents.length, `${mtimeNs}`, `${ctimeNs}`, `${ino}`]))
    .update(contents)
}

function hashDirectory(hash, directory, buildInputs = false) {
  for (const file of listFiles(directory).sort()) {
    if (buildInputs) {
      hashBuildInput(hash, join(directory, file))
      continue
    }
    const contents = readFileSync(join(directory, file))
    hash.update(JSON.stringify([directory, file, contents.length])).update(contents)
  }
}

function distFingerprint(packageDir) {
  const dist = join(packageDir, 'dist')
  if (!existsSync(dist)) {
    return null
  }
  const hash = createHash('sha256')
  hashDirectory(hash, dist)
  return hash.digest('hex')
}

function inputFingerprint(packageDir, compiler, compiledFiles) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const config = JSON.parse(readFileSync(join(packageDir, 'tsconfig.json'), 'utf8'))
    const options = config.compilerOptions ?? {}
    // Reuse is deliberately limited to this package's self-contained compiler inputs.
    if (
      manifest.name !== '@orca/process-host' ||
      config.extends ||
      config.references ||
      config.files ||
      !config.include?.every((pattern) => pattern.startsWith('src/')) ||
      options.paths ||
      options.baseUrl ||
      options.rootDirs ||
      options.typeRoots ||
      options.libReplacement === true ||
      !Array.isArray(options.types) ||
      options.types.some((type) => type !== 'node') ||
      ['dependencies', 'optionalDependencies', 'peerDependencies'].some(
        (field) => Object.keys(manifest[field] ?? {}).length > 0
      )
    ) {
      return null
    }
    const require = createRequire(compiler)
    const compilerManifest = require.resolve('typescript/package.json')
    const compilerDir = dirname(compilerManifest)
    const metadata = JSON.parse(readFileSync(compilerManifest, 'utf8'))
    const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`
    if (!metadata.optionalDependencies?.[nativeName]) {
      return null
    }
    const roots = [
      join(packageDir, 'src'),
      import.meta.dirname,
      join(compilerDir, 'bin'),
      join(compilerDir, 'lib'),
      dirname(require.resolve(`${nativeName}/package.json`))
    ]
    if (options.types?.includes('node')) {
      const nodeTypes = createRequire(join(packageDir, 'package.json')).resolve(
        '@types/node/package.json'
      )
      const undiciTypes = createRequire(nodeTypes).resolve('undici-types/package.json')
      const nodeMetadata = JSON.parse(readFileSync(nodeTypes, 'utf8'))
      const undiciMetadata = JSON.parse(readFileSync(undiciTypes, 'utf8'))
      if (
        Object.keys(nodeMetadata.dependencies ?? {}).some((name) => name !== 'undici-types') ||
        Object.keys(undiciMetadata.dependencies ?? {}).length > 0
      ) {
        return null
      }
      roots.push(dirname(nodeTypes), dirname(undiciTypes))
    }
    // TypeScript can reach external declarations even without manifest dependencies.
    if (
      compiledFiles &&
      (!compiledFiles.length ||
        compiledFiles.some(
          (file) =>
            !isAbsolute(file) ||
            !roots.some((root) => {
              const within = relative(realpathSync(root), realpathSync(file))
              return within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)
            })
        ))
    ) {
      return null
    }
    const hash = createHash('sha256').update(
      JSON.stringify([process.version, process.platform, process.arch])
    )
    for (const file of [
      join(packageDir, 'package.json'),
      join(packageDir, 'tsconfig.json'),
      compilerManifest,
      compiler
    ]) {
      hashBuildInput(hash, file)
    }
    for (const root of roots) {
      hashDirectory(hash, root, true)
    }
    return hash.digest('hex')
  } catch {
    // Unknown configuration or dependencies compile normally, without reusable state.
    return null
  }
}

function hasReusableDist(packageDir, input) {
  if (input === null) {
    return false
  }
  try {
    const state = JSON.parse(readFileSync(join(packageDir, BUILD_STATE_FILE), 'utf8'))
    return state.input === input && state.output === distFingerprint(packageDir)
  } catch {
    return false
  }
}

const STAGING_PREFIX = '.dist-staging-'
const LOCK_PATH = '.dist-build.lock'
const LOCK_STALE_MS = 30_000
const COMPILE_TIMEOUT_MS = 120_000
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

function resolvePackageCompiler(packageDir) {
  const manifestPath = createRequire(join(packageDir, 'package.json')).resolve(
    'typescript/package.json'
  )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsc
  if (!bin) {
    throw new Error(`${manifestPath} does not declare a tsc binary`)
  }
  return join(dirname(manifestPath), bin)
}

function listFiles(directory, base = directory) {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path, base) : [relative(base, path)]
  })
}

function removeEmptyDirectories(directory, root) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirectories(join(directory, entry.name), root)
    }
  }
  if (directory !== root && readdirSync(directory).length === 0) {
    rmdirSync(directory)
  }
}

async function renameReplacing(source, target, assertLockHeld) {
  // Windows reports a transient sharing violation while a scanner or loader has the target open.
  for (let attempt = 0; ; attempt += 1) {
    // Rechecked per attempt because the retry delay lets the lock be lost.
    assertLockHeld()
    try {
      renameSync(source, target)
      return
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !RETRYABLE_RENAME_CODES.has(error.code) ||
        attempt >= 20
      ) {
        throw error
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
  }
}

async function syncCompiledOutput(stagingDir, distDir, assertLockHeld) {
  assertLockHeld()
  const staged = listFiles(stagingDir)
  const stagedSet = new Set(staged)
  const result = { written: 0, removed: 0, unchanged: 0 }
  mkdirSync(distDir, { recursive: true })
  const existing = new Set(listFiles(distDir))
  // New dependencies must exist before any replacement can import them.
  const publicationOrder = [
    ...staged.filter((file) => !existing.has(file)),
    ...staged.filter((file) => existing.has(file))
  ]
  for (const file of publicationOrder) {
    const source = join(stagingDir, file)
    const target = join(distDir, file)
    if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) {
      result.unchanged += 1
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    await renameReplacing(source, target, assertLockHeld)
    result.written += 1
  }
  // Outputs of renamed or deleted sources would otherwise ship and stay importable.
  for (const file of existing) {
    if (!stagedSet.has(file)) {
      assertLockHeld()
      rmSync(join(distDir, file), { force: true })
      result.removed += 1
    }
  }
  assertLockHeld()
  removeEmptyDirectories(distDir, distDir)
  return result
}

async function compileAndSync(packageDir, compiler, assertLockHeld) {
  // Same depth as dist so emitted source-map paths are identical once moved.
  const stagingDir = join(packageDir, `${STAGING_PREFIX}${randomUUID().slice(0, 8)}`)
  try {
    const compile = await runProcess({
      program: process.execPath,
      args: [compiler, '-p', 'tsconfig.json', '--outDir', stagingDir, '--listFiles'],
      cwd: packageDir,
      timeoutMs: COMPILE_TIMEOUT_MS
    })
    if (compile.code !== 0) {
      const detail = [compile.stdout, compile.stderr].filter(Boolean).join('\n').trim()
      const reason = compile.timedOut ? 'timed out' : (compile.signal ?? compile.code)
      throw new Error(`process-host compilation failed (${reason})${detail ? `:\n${detail}` : ''}`)
    }
    return {
      result: await syncCompiledOutput(stagingDir, join(packageDir, 'dist'), assertLockHeld),
      compiledFiles: compile.stdout
        .split('\n')
        .map((file) => file.trim())
        .filter(Boolean)
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

export async function buildPackageDist(packageDir) {
  const lockfilePath = join(packageDir, LOCK_PATH)
  let compromised
  // Held across compile and sync so an older source snapshot cannot publish after a newer one.
  const release = await lockfile.lock(packageDir, {
    lockfilePath,
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: { retries: 1_000, minTimeout: 50, maxTimeout: 250 },
    onCompromised: (error) => {
      compromised = error
    }
  })
  // Reject before publishing after proper-lockfile observes a lost lock.
  const assertLockHeld = () => {
    if (compromised) {
      throw new Error(
        `process-host build lock was compromised; stopped publishing dist: ${compromised.message}`
      )
    }
  }
  try {
    // Only the lock holder stages, so leftovers are from a killed build.
    for (const name of readdirSync(packageDir)) {
      if (name.startsWith(STAGING_PREFIX)) {
        rmSync(join(packageDir, name), { recursive: true, force: true })
      }
    }
    const compiler = resolvePackageCompiler(packageDir)
    const input = inputFingerprint(packageDir, compiler)
    if (hasReusableDist(packageDir, input)) {
      assertLockHeld()
      return { written: 0, removed: 0, unchanged: listFiles(join(packageDir, 'dist')).length }
    }
    assertLockHeld()
    rmSync(join(packageDir, BUILD_STATE_FILE), { force: true })
    const { result, compiledFiles } = await compileAndSync(packageDir, compiler, assertLockHeld)
    assertLockHeld()
    if (input !== null && input === inputFingerprint(packageDir, compiler, compiledFiles)) {
      const output = distFingerprint(packageDir)
      assertLockHeld()
      writeFileSync(join(packageDir, BUILD_STATE_FILE), JSON.stringify({ input, output }))
    }
    return result
  } finally {
    // proper-lockfile already untracks compromised locks; releasing one could affect its new owner.
    if (!compromised) {
      await release()
    }
  }
}

// realpath: the entry path may reach this file through a symlinked directory.
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    const packageDir = resolve(process.argv[2] ?? dirname(import.meta.dirname))
    const result = await buildPackageDist(packageDir)
    if (result.written > 0 || result.removed > 0) {
      console.log(
        `process-host dist: ${result.written} written, ${result.removed} removed, ${result.unchanged} unchanged`
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
