import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'
import { DESKTOP_RC_TAG, DESKTOP_STABLE_TAG } from './release-tag-patterns.mjs'
import { getTarProgram } from './zip-extractor-command.mjs'

const REQUIRED_FILES = [
  'cli/index.js',
  'main/index.js',
  'preload/index.js',
  'renderer/index.html',
  'renderer/.vite/manifest.json',
  'web/web-index.html',
  'mobile-web/manifest.json',
  'package.json'
]
const NATIVE_FILE = /\.(?:node|exe|dll|dylib|so(?:\.\d+)*|a)$/i
const ARCHIVE_NAME = 'release-javascript.tar.gz'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function command(program, args, cwd) {
  const result = runProcessSync({ program, args, cwd, timeoutMs: 120_000 })
  assert.equal(result.code, 0, describeProcessFailure(result))
  return result.stdout.trim()
}

export function releaseBuildIdentity(tag) {
  if (DESKTOP_RC_TAG.test(tag)) {
    return 'rc'
  }
  if (DESKTOP_STABLE_TAG.test(tag)) {
    return 'stable'
  }
  throw new Error(`Invalid desktop release tag: ${tag}`)
}

export function releaseJavascriptConfiguration(root, env = process.env) {
  const sourceSha = command('git', ['rev-parse', 'HEAD'], root)
  assert.match(sourceSha, /^[a-f0-9]{40}$/)
  if (env.ORCA_RELEASE_JAVASCRIPT_SOURCE_SHA) {
    assert.equal(
      sourceSha,
      env.ORCA_RELEASE_JAVASCRIPT_SOURCE_SHA,
      'Release checkout differs from bundle source'
    )
  }
  const { version, packageManager } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const identity = releaseBuildIdentity(`v${version}`)
  assert.equal(env.ORCA_BUILD_IDENTITY, identity, 'Release build identity differs from version')
  assert(env.ORCA_DIAGNOSTICS_TOKEN_URL, 'Missing release diagnostics URL')
  assert(env.ORCA_POSTHOG_WRITE_KEY, 'Missing release telemetry key')
  return {
    sourceSha,
    version,
    packageManager,
    identity,
    diagnosticsTokenUrl: env.ORCA_DIAGNOSTICS_TOKEN_URL,
    telemetryKeySha256: sha256(env.ORCA_POSTHOG_WRITE_KEY)
  }
}

export function javascriptInventory(directory, prefix = '', { excludeHostOutput = false } = {}) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const hostOutput = ['relay', 'orcad-template', 'orcad-prebuilds'].includes(name.split('/')[0])
      if (excludeHostOutput && hostOutput) {
        return []
      }
      assert(!entry.isSymbolicLink(), `JavaScript artifact contains a symlink: ${name}`)
      assert(!NATIVE_FILE.test(name), `JavaScript artifact contains a native binary: ${name}`)
      assert(!hostOutput, `JavaScript artifact contains host output: ${name}`)
      const file = join(directory, entry.name)
      if (entry.isDirectory()) {
        return javascriptInventory(file, name, { excludeHostOutput })
      }
      assert(entry.isFile(), `JavaScript artifact contains a special file: ${name}`)
      const bytes = readFileSync(file)
      return [{ path: name, bytes: bytes.length, sha256: sha256(bytes) }]
    })
}

function verifyRequiredFiles(files) {
  const present = new Set(files.map((file) => file.path))
  for (const file of REQUIRED_FILES) {
    assert(present.has(file), `Missing JavaScript output: ${file}`)
  }
}

export function packReleaseJavascript({ root = process.cwd(), artifactDir, configuration }) {
  configuration ??= releaseJavascriptConfiguration(root)
  const out = join(root, 'out')
  const files = javascriptInventory(out)
  verifyRequiredFiles(files)
  mkdirSync(artifactDir, { recursive: true })
  const archive = join(artifactDir, ARCHIVE_NAME)
  command(getTarProgram(), ['-czf', archive, '-C', root, 'out'], root)
  const manifest = {
    schema: 1,
    configuration,
    archiveSha256: sha256(readFileSync(archive)),
    archiveBytes: statSync(archive).size,
    files
  }
  writeFileSync(join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function restoreReleaseJavascript({ root = process.cwd(), artifactDir, configuration }) {
  configuration ??= releaseJavascriptConfiguration(root)
  const manifest = JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 1, 'Unsupported JavaScript artifact schema')
  assert.deepEqual(manifest.configuration, configuration, 'JavaScript build configuration differs')
  const archive = join(artifactDir, ARCHIVE_NAME)
  assert.equal(sha256(readFileSync(archive)), manifest.archiveSha256, 'JavaScript archive differs')
  const entries = command(getTarProgram(), ['-tzf', archive], root).split(/\r?\n/)
  for (const entry of entries) {
    assert(entry === 'out/' || entry.startsWith('out/'), `Unexpected archive entry: ${entry}`)
    assert(
      !entry.includes('\\') && !entry.split('/').includes('..'),
      `Unsafe archive entry: ${entry}`
    )
  }
  mkdirSync(join(root, '.build'), { recursive: true })
  const temporary = mkdtempSync(join(root, '.build', 'release-javascript-'))
  try {
    command(getTarProgram(), ['-xzf', archive, '-C', temporary], root)
    const staged = join(temporary, 'out')
    const files = javascriptInventory(staged)
    verifyRequiredFiles(files)
    assert.deepEqual(files, manifest.files, 'JavaScript file inventory differs')
    rmSync(join(root, 'out'), { recursive: true, force: true })
    renameSync(staged, join(root, 'out'))
    if (process.platform !== 'win32') {
      chmodSync(join(root, 'out', 'cli', 'index.js'), 0o755)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return manifest
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const [mode, artifact] = process.argv.slice(2)
  if (mode === 'identity') {
    console.log(releaseBuildIdentity(process.env.RELEASE_TAG))
  } else {
    const artifactDir = resolve(artifact ?? '.build/release-javascript')
    const result =
      mode === 'pack'
        ? packReleaseJavascript({ artifactDir })
        : mode === 'restore'
          ? restoreReleaseJavascript({ artifactDir })
          : assert.fail('Expected pack, restore, or identity')
    console.log(
      `[release-javascript] ${mode}: ${result.files.length} files, ${result.archiveBytes} archived bytes`
    )
  }
}
