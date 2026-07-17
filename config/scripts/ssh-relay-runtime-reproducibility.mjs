import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The bounded output adds four release assets around a runtime tree capped at 5,000 entries.
const MAX_ENTRIES = 6_000
const MAX_FILE_BYTES = 250 * 1024 * 1024
const MAX_TOTAL_BYTES = 500 * 1024 * 1024
const MAX_PATH_BYTES = 512
const MAX_PATH_DEPTH = 40
const MAX_IDENTITY_BYTES = 1024 * 1024
const COMPARISON_TIMEOUT_MS = 5 * 60 * 1000
const SUPPORTED_TUPLES = new Set([
  'linux-x64-glibc',
  'linux-arm64-glibc',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
])

async function sha256File(path, signal) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) {
    signal.throwIfAborted()
    digest.update(chunk)
  }
  return `sha256:${digest.digest('hex')}`
}

function validateRelativePath(path) {
  if (
    Buffer.byteLength(path) > MAX_PATH_BYTES ||
    path.split('/').length > MAX_PATH_DEPTH ||
    path.includes('\\')
  ) {
    throw new Error(`reproducibility output path exceeds limits: ${path}`)
  }
}

async function snapshotOutput(directory, label, signal) {
  const entries = new Map()
  let files = 0
  let bytes = 0

  async function visit(absoluteDirectory, relativeDirectory = '') {
    const children = []
    const handle = await opendir(absoluteDirectory)
    for await (const child of handle) {
      children.push(child.name)
    }
    children.sort()
    for (const name of children) {
      signal.throwIfAborted()
      const path = relativeDirectory ? `${relativeDirectory}/${name}` : name
      validateRelativePath(path)
      const absolutePath = join(absoluteDirectory, name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error(`${label} contains a prohibited special entry: ${path}`)
      }
      if (entries.size >= MAX_ENTRIES) {
        throw new Error(`${label} exceeds the reproducibility entry-count limit`)
      }
      if (metadata.isDirectory()) {
        entries.set(path, { path, type: 'directory', mode: metadata.mode & 0o777 })
        await visit(absolutePath, path)
        continue
      }
      if (metadata.size > MAX_FILE_BYTES) {
        throw new Error(`${label} file exceeds the reproducibility size limit: ${path}`)
      }
      files += 1
      bytes += metadata.size
      if (bytes > MAX_TOTAL_BYTES) {
        throw new Error(`${label} exceeds the reproducibility total-size limit`)
      }
      entries.set(path, {
        path,
        type: 'file',
        mode: metadata.mode & 0o777,
        size: metadata.size,
        sha256: await sha256File(absolutePath, signal)
      })
    }
  }

  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`)
  }
  await visit(directory)
  return { bytes, entries, files }
}

async function validateCompleteOutput(directory, label, tuple, snapshot) {
  const identityName = `orca-ssh-relay-runtime-${tuple}.identity.json`
  const required = [
    'runtime',
    'runtime/relay.js',
    'runtime/relay-watcher.js',
    'runtime/runtime-metadata.json',
    identityName,
    `orca-ssh-relay-runtime-${tuple}.spdx.json`,
    `orca-ssh-relay-runtime-${tuple}.provenance.json`
  ]
  for (const path of required) {
    if (!snapshot.entries.has(path)) {
      throw new Error(`${label} is missing required asset: ${path}`)
    }
  }
  const identityEntry = snapshot.entries.get(identityName)
  if (identityEntry.type !== 'file' || identityEntry.size > MAX_IDENTITY_BYTES) {
    throw new Error(`${label} identity exceeds its size or type contract`)
  }
  let identity
  try {
    identity = JSON.parse(await readFile(join(directory, identityName), 'utf8'))
  } catch {
    throw new Error(`${label} identity is not valid JSON`)
  }
  if (
    identity.tupleId !== tuple ||
    !/^sha256:[0-9a-f]{64}$/.test(identity.contentId) ||
    typeof identity.archive?.name !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(identity.archive.sha256)
  ) {
    throw new Error(`${label} identity does not match the requested tuple or digest contract`)
  }
  if (!snapshot.entries.has(identity.archive.name)) {
    throw new Error(`${label} is missing required asset: ${identity.archive.name}`)
  }
  const archiveEntry = snapshot.entries.get(identity.archive.name)
  if (archiveEntry.type !== 'file' || archiveEntry.sha256 !== identity.archive.sha256) {
    throw new Error(`${label} archive digest does not match its identity`)
  }
  const expectedTopLevel = new Set([...required.slice(4), identity.archive.name, 'runtime'])
  const unexpected = [...snapshot.entries.keys()].find(
    (path) => !path.includes('/') && !expectedTopLevel.has(path)
  )
  if (unexpected) {
    throw new Error(`${label} contains an unexpected top-level asset: ${unexpected}`)
  }
  return identity
}

function compareSnapshots(first, second) {
  const paths = [...new Set([...first.entries.keys(), ...second.entries.keys()])].sort(
    (left, right) => {
      // Runtime bytes are the producer root cause; metadata and archive names often drift after them.
      const leftPriority = left === 'runtime' || left.startsWith('runtime/') ? 0 : 1
      const rightPriority = right === 'runtime' || right.startsWith('runtime/') ? 0 : 1
      return leftPriority - rightPriority || left.localeCompare(right)
    }
  )
  for (const path of paths) {
    const left = first.entries.get(path)
    const right = second.entries.get(path)
    if (!left) {
      throw new Error(`first output is missing reproducibility entry: ${path}`)
    }
    if (!right) {
      throw new Error(`second output is missing reproducibility entry: ${path}`)
    }
    for (const field of ['type', 'mode', 'size', 'sha256']) {
      if (left[field] !== right[field]) {
        throw new Error(`reproducibility mismatch for ${path}: ${field}`)
      }
    }
  }
}

export async function verifySshRelayRuntimeReproducibility({
  firstOutputDirectory,
  secondOutputDirectory,
  tuple,
  signal = AbortSignal.timeout(COMPARISON_TIMEOUT_MS)
}) {
  const started = process.hrtime.bigint()
  if (!SUPPORTED_TUPLES.has(tuple)) {
    throw new Error(`unsupported runtime reproducibility tuple: ${tuple}`)
  }
  const firstDirectory = resolve(firstOutputDirectory)
  const secondDirectory = resolve(secondOutputDirectory)
  if (firstDirectory === secondDirectory) {
    throw new Error('clean-build outputs must be distinct directories')
  }
  signal.throwIfAborted()
  const [firstRealPath, secondRealPath] = await Promise.all([
    realpath(firstDirectory),
    realpath(secondDirectory)
  ])
  if (firstRealPath === secondRealPath) {
    throw new Error('clean-build outputs must resolve to distinct directories')
  }

  // Walk sequentially so the clean-build gate cannot double file and read pressure on CI runners.
  const first = await snapshotOutput(firstDirectory, 'first output', signal)
  const second = await snapshotOutput(secondDirectory, 'second output', signal)
  const firstIdentity = await validateCompleteOutput(firstDirectory, 'first output', tuple, first)
  const secondIdentity = await validateCompleteOutput(
    secondDirectory,
    'second output',
    tuple,
    second
  )
  compareSnapshots(first, second)
  if (
    firstIdentity.contentId !== secondIdentity.contentId ||
    firstIdentity.archive.sha256 !== secondIdentity.archive.sha256
  ) {
    throw new Error('reproducibility identity or archive digest mismatch')
  }

  return {
    tuple,
    contentId: firstIdentity.contentId,
    archiveSha256: firstIdentity.archive.sha256,
    entries: first.entries.size,
    files: first.files,
    bytes: first.bytes,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6
  }
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseReproducibilityArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = valueAfter(argv, index, flag)
    if (flag === '--tuple') {
      result.tuple = value
    } else if (flag === '--first-output-directory') {
      result.firstOutputDirectory = resolve(value)
    } else if (flag === '--second-output-directory') {
      result.secondOutputDirectory = resolve(value)
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
    index += 1
  }
  for (const field of ['tuple', 'firstOutputDirectory', 'secondOutputDirectory']) {
    if (!result[field]) {
      throw new Error(`Missing required reproducibility argument: ${field}`)
    }
  }
  return result
}

async function main() {
  const result = await verifySshRelayRuntimeReproducibility(
    parseReproducibilityArguments(process.argv.slice(2))
  )
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write(
      `SSH relay runtime reproducibility verification failed: ${error.message}\n`
    )
    process.exitCode = 1
  })
}
