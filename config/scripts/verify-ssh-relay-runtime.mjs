import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { inspectSshRelayRuntimeArchive } from './ssh-relay-runtime-archive.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'

const execFileAsync = promisify(execFile)
const scriptDirectory = import.meta.dirname
const MAX_SMOKE_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_SMOKE_FAILURE_DETAIL_BYTES = 64 * 1024
const SMOKE_TIMEOUT_MS = 45_000

function boundedSshRelayRuntimeSmokeDetail(value) {
  const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString() : ''
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_SMOKE_FAILURE_DETAIL_BYTES) {
    return text
  }
  const retained = bytes.subarray(bytes.length - MAX_SMOKE_FAILURE_DETAIL_BYTES).toString()
  return `[truncated ${bytes.length - MAX_SMOKE_FAILURE_DETAIL_BYTES} bytes]\n${retained}`
}

export function formatSshRelayRuntimeSmokeFailure(error) {
  return [
    'Bundled runtime smoke command failed:',
    `timeoutMs=${SMOKE_TIMEOUT_MS}`,
    `code=${JSON.stringify(error?.code ?? null)}`,
    `killed=${JSON.stringify(error?.killed ?? false)}`,
    `signal=${JSON.stringify(error?.signal ?? null)}`,
    `message=${JSON.stringify(error?.message ?? String(error))}`,
    `stdout=${JSON.stringify(boundedSshRelayRuntimeSmokeDetail(error?.stdout))}`,
    `stderr=${JSON.stringify(boundedSshRelayRuntimeSmokeDetail(error?.stderr))}`
  ].join(' ')
}

function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    if (flag === '--runtime-directory') {
      result.runtimeDirectory = resolve(value)
    } else if (flag === '--identity') {
      result.identityPath = resolve(value)
    } else if (flag === '--archive') {
      result.archivePath = resolve(value)
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  if (!result.runtimeDirectory || !result.identityPath) {
    throw new Error('--runtime-directory and --identity are required')
  }
  return result
}

async function actualTree(runtimeDirectory, signal) {
  const results = new Map()
  async function visit(directory) {
    signal?.throwIfAborted()
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      signal?.throwIfAborted()
      const absolutePath = join(directory, child.name)
      const path = relative(runtimeDirectory, absolutePath).split(sep).join('/')
      if (results.has(path.toLowerCase())) {
        throw new Error(`Runtime tree case-fold collision: ${path}`)
      }
      if (child.isDirectory()) {
        const metadata = await stat(absolutePath)
        results.set(path.toLowerCase(), {
          path,
          type: 'directory',
          mode: process.platform === 'win32' ? null : metadata.mode & 0o777
        })
        await visit(absolutePath)
      } else if (child.isFile()) {
        const [metadata, bytes] = await Promise.all([
          stat(absolutePath),
          readFile(absolutePath, { signal })
        ])
        results.set(path.toLowerCase(), {
          path,
          type: 'file',
          size: bytes.length,
          mode: process.platform === 'win32' ? null : metadata.mode & 0o777,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
        })
      } else {
        throw new Error(`Runtime tree contains prohibited entry: ${path}`)
      }
    }
  }
  await visit(runtimeDirectory)
  return results
}

export async function verifyRuntimeTree(runtimeDirectory, identity, { signal } = {}) {
  const actual = await actualTree(runtimeDirectory, signal)
  for (const expected of identity.entries) {
    signal?.throwIfAborted()
    const entry = actual.get(expected.path.toLowerCase())
    if (
      !entry ||
      entry.path !== expected.path ||
      entry.type !== expected.type ||
      // Why: NTFS has no execute bit; the verified ZIP carries canonical mode metadata instead.
      (process.platform !== 'win32' && entry.mode !== expected.mode)
    ) {
      throw new Error(`Runtime tree entry mismatch: ${expected.path}`)
    }
    if (
      expected.type === 'file' &&
      (entry.size !== expected.size || entry.sha256 !== expected.sha256)
    ) {
      throw new Error(`Runtime tree file integrity mismatch: ${expected.path}`)
    }
    actual.delete(expected.path.toLowerCase())
  }
  if (actual.size > 0) {
    throw new Error(`Runtime tree has undeclared entry: ${actual.values().next().value.path}`)
  }
  const contentId = computeSshRelayRuntimeContentId(identity)
  if (contentId !== identity.contentId) {
    throw new Error('Runtime tree content identity mismatch')
  }
  return {
    entries: identity.entries.length,
    files: identity.entries.filter((entry) => entry.type === 'file').length,
    expandedBytes: identity.expandedSize,
    contentId
  }
}

async function runBundledSmoke(runtimeDirectory, identity, signal) {
  const nodePath = join(runtimeDirectory, 'bin', identity.os === 'win32' ? 'node.exe' : 'node')
  const childPath = resolve(scriptDirectory, 'ssh-relay-runtime-smoke-child.cjs')
  let result
  try {
    result = await execFileAsync(nodePath, [childPath, runtimeDirectory], {
      cwd: runtimeDirectory,
      encoding: 'utf8',
      maxBuffer: MAX_SMOKE_OUTPUT_BYTES,
      timeout: SMOKE_TIMEOUT_MS,
      windowsHide: true,
      signal
    })
  } catch (error) {
    // The child classifies PTY/watcher failures; retain its bounded tail to avoid blind CI retries.
    throw new Error(formatSshRelayRuntimeSmokeFailure(error), { cause: error })
  }
  const smoke = JSON.parse(result.stdout)
  if (smoke.nodeVersion !== `v${identity.nodeVersion}`) {
    throw new Error(`Bundled smoke used unexpected Node version: ${smoke.nodeVersion}`)
  }
  return smoke
}

export async function verifyExtractedSshRelayRuntime({
  runtimeDirectory,
  identity,
  archivePath,
  signal
}) {
  signal?.throwIfAborted()
  const started = process.hrtime.bigint()
  const archive = archivePath
    ? await inspectSshRelayRuntimeArchive(archivePath, identity, { signal })
    : null
  const tree = await verifyRuntimeTree(runtimeDirectory, identity, { signal })
  // Why: native code runs only after the complete extracted tree matches its content identity.
  const smoke = await runBundledSmoke(runtimeDirectory, identity, signal)
  signal?.throwIfAborted()
  return {
    tuple: identity.tupleId,
    archive,
    tree,
    smoke,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6
  }
}

export async function verifySshRelayRuntime({
  runtimeDirectory,
  identityPath,
  archivePath,
  signal
}) {
  const identity = JSON.parse(await readFile(identityPath, { encoding: 'utf8', signal }))
  return verifyExtractedSshRelayRuntime({ runtimeDirectory, identity, archivePath, signal })
}

async function main() {
  const result = await verifySshRelayRuntime(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write(`SSH relay runtime verification failed: ${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
