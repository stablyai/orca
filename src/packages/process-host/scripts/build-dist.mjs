import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import lockfile from 'proper-lockfile'

// Source resolution bootstraps compilation without requiring an existing dist.

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

async function compileAndSync(packageDir, assertLockHeld) {
  // Only the lock holder stages, so any staging directory left here is from a killed build.
  for (const name of readdirSync(packageDir)) {
    if (name.startsWith(STAGING_PREFIX)) {
      rmSync(join(packageDir, name), { recursive: true, force: true })
    }
  }
  // Same depth as dist so emitted source-map paths are identical once moved.
  const stagingDir = join(packageDir, `${STAGING_PREFIX}${randomUUID().slice(0, 8)}`)
  try {
    const compile = await runProcess({
      program: process.execPath,
      args: [resolvePackageCompiler(packageDir), '-p', 'tsconfig.json', '--outDir', stagingDir],
      cwd: packageDir,
      timeoutMs: COMPILE_TIMEOUT_MS
    })
    if (compile.code !== 0) {
      const detail = [compile.stdout, compile.stderr].filter(Boolean).join('\n').trim()
      const reason = compile.timedOut ? 'timed out' : (compile.signal ?? compile.code)
      throw new Error(`process-host compilation failed (${reason})${detail ? `:\n${detail}` : ''}`)
    }
    return await syncCompiledOutput(stagingDir, join(packageDir, 'dist'), assertLockHeld)
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
    const result = await compileAndSync(packageDir, assertLockHeld)
    assertLockHeld()
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
