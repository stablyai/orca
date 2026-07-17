import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { buildPatchedSshRelayNodePty } from './ssh-relay-node-pty-build.mjs'
import { extractVerifiedSshRelayNodeBuildInputs } from './ssh-relay-node-tar-inspection.mjs'
import { extractVerifiedSshRelayNodeZipBuildInputs } from './ssh-relay-node-zip-inspection.mjs'
import { applySshRelayLinuxNodeGypCompilerFloor } from './ssh-relay-linux-node-gyp-compiler.mjs'
import {
  createSshRelayRuntimeArchive,
  inspectSshRelayRuntimeArchive
} from './ssh-relay-runtime-archive.mjs'
import { writeSshRelayRuntimeMetadata } from './ssh-relay-runtime-provenance.mjs'
import {
  collectSshRelayRuntimeToolchain,
  sshRelayRuntimeBuilderIdentity,
  sshRelayRuntimeRunnerIdentity
} from './ssh-relay-runtime-toolchain.mjs'
import { assembleSshRelayRuntimeTree } from './ssh-relay-runtime-tree.mjs'
import { validateSshRelayNodeReleaseContract } from './ssh-relay-node-release-verification.mjs'
import { verifyNodeReleaseInputs } from './verify-ssh-relay-node-release-inputs.mjs'

const execFileAsync = promisify(execFile)
const scriptDirectory = import.meta.dirname
const projectRoot = resolve(scriptDirectory, '..', '..')
const defaultContractPath = resolve(projectRoot, 'config', 'ssh-relay-node-release-v24.18.0.json')
const SUPPORTED_TUPLES = new Set([
  'linux-x64-glibc',
  'linux-arm64-glibc',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
])
const BUILD_COMMAND_TIMEOUT_MS = 10 * 60 * 1000

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseBuildArguments(argv) {
  const result = { contractPath: defaultContractPath }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = valueAfter(argv, index, flag)
    if (flag === '--tuple') {
      result.tuple = value
    } else if (flag === '--inputs-directory') {
      result.inputsDirectory = resolve(value)
    } else if (flag === '--output-directory') {
      result.outputDirectory = resolve(value)
    } else if (flag === '--work-directory') {
      result.workDirectory = resolve(value)
    } else if (flag === '--contract') {
      result.contractPath = resolve(value)
    } else if (flag === '--source-date-epoch') {
      result.sourceDateEpoch = Number(value)
    } else if (flag === '--git-commit') {
      result.gitCommit = value
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
    index += 1
  }
  for (const field of [
    'tuple',
    'inputsDirectory',
    'outputDirectory',
    'workDirectory',
    'sourceDateEpoch',
    'gitCommit'
  ]) {
    if (result[field] === undefined) {
      throw new Error(`Missing required build argument: ${field}`)
    }
  }
  if (!SUPPORTED_TUPLES.has(result.tuple)) {
    throw new Error(`Unsupported runtime build tuple: ${result.tuple}`)
  }
  if (!Number.isSafeInteger(result.sourceDateEpoch) || result.sourceDateEpoch < 0) {
    throw new Error('--source-date-epoch must be a non-negative safe integer')
  }
  if (!/^[0-9a-f]{40}$/.test(result.gitCommit)) {
    throw new Error('--git-commit must be a full lowercase SHA-1')
  }
  return result
}

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function assertDisjointRuntimeBuildDirectories(outputDirectory, workDirectory) {
  if (
    containsPath(outputDirectory, workDirectory) ||
    containsPath(workDirectory, outputDirectory)
  ) {
    throw new Error('Runtime output and work directories must be disjoint')
  }
}

function assertTargetNative(tuple) {
  const os = tuple.startsWith('linux-') ? 'linux' : tuple.startsWith('darwin-') ? 'darwin' : 'win32'
  const architecture = tuple.includes('arm64') ? 'arm64' : 'x64'
  if (process.platform !== os || process.arch !== architecture) {
    throw new Error(`Runtime ${tuple} must be assembled on target-native ${os}/${architecture}`)
  }
  if (os === 'linux') {
    const glibc = process.report?.getReport?.().header?.glibcVersionRuntime
    if (typeof glibc !== 'string' || glibc.length === 0) {
      throw new Error(`Runtime ${tuple} requires a native glibc build environment`)
    }
  }
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? BUILD_COMMAND_TIMEOUT_MS,
    windowsHide: true
  })
  if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  return result.stdout.trim()
}

function relayPlatform(tuple) {
  return tuple.replace('-glibc', '')
}

export async function buildSshRelayRuntime(options) {
  const started = process.hrtime.bigint()
  assertTargetNative(options.tuple)
  assertDisjointRuntimeBuildDirectories(options.outputDirectory, options.workDirectory)
  const release = validateSshRelayNodeReleaseContract(
    JSON.parse(await readFile(options.contractPath, 'utf8'))
  )
  await verifyNodeReleaseInputs({
    contractPath: options.contractPath,
    inputsDirectory: options.inputsDirectory,
    archiveTuples: [options.tuple]
  })
  const workDirectory = options.workDirectory
  // Why: both final and clean-build paths are exclusive, but callers need not pre-create parents.
  await Promise.all([
    mkdir(dirname(options.outputDirectory), { recursive: true }),
    mkdir(dirname(workDirectory), { recursive: true })
  ])
  await mkdir(options.outputDirectory)
  let workDirectoryCreated = false
  try {
    await mkdir(workDirectory)
    workDirectoryCreated = true
    await run(process.execPath, [resolve(scriptDirectory, 'build-relay.mjs')], { cwd: projectRoot })
    const extractedDirectory = join(workDirectory, 'node-inputs')
    const nodeArchivePath = join(options.inputsDirectory, release.archives[options.tuple].name)
    const extracted = options.tuple.startsWith('win32-')
      ? await extractVerifiedSshRelayNodeZipBuildInputs(
          release,
          options.tuple,
          nodeArchivePath,
          extractedDirectory,
          {
            headersArchivePath: join(
              options.inputsDirectory,
              release.windowsBuildInputs.headersArchive.name
            ),
            importLibraryPath: join(
              options.inputsDirectory,
              ...release.windowsBuildInputs.importLibraries[options.tuple].name.split('/')
            )
          }
        )
      : await extractVerifiedSshRelayNodeBuildInputs(
          release,
          options.tuple,
          nodeArchivePath,
          extractedDirectory
        )
    const bundledVersion = await run(extracted.nodePath, ['--version'])
    if (bundledVersion !== `v${release.nodeVersion}`) {
      throw new Error(`Bundled Node version mismatch: ${bundledVersion}`)
    }
    await applySshRelayLinuxNodeGypCompilerFloor({
      nodeRoot: extracted.extractedRoot,
      tuple: options.tuple
    })
    const nodePty = await buildPatchedSshRelayNodePty({
      projectRoot,
      nodePath: extracted.nodePath,
      nodeRoot: extracted.extractedRoot,
      nodeVersion: release.nodeVersion,
      tuple: options.tuple,
      buildDirectory: join(workDirectory, 'node-pty')
    })
    const runtimeRoot = join(options.outputDirectory, 'runtime')
    const identity = await assembleSshRelayRuntimeTree({
      tuple: options.tuple,
      nodeRoot: extracted.extractedRoot,
      nodePtyBuildDirectory: nodePty.buildDirectory,
      relayDirectory: resolve(projectRoot, 'out', 'relay', relayPlatform(options.tuple)),
      runtimeRoot,
      nodeVersion: release.nodeVersion
    })
    const archive = await createSshRelayRuntimeArchive({
      runtimeRoot,
      outputDirectory: options.outputDirectory,
      identity,
      sourceDateEpoch: options.sourceDateEpoch
    })
    const inspection = await inspectSshRelayRuntimeArchive(archive.path, identity)
    const toolchain = await collectSshRelayRuntimeToolchain(extracted.nodePath)
    const metadata = await writeSshRelayRuntimeMetadata({
      outputDirectory: options.outputDirectory,
      identity,
      archive,
      nodeRelease: release,
      sourceDateEpoch: options.sourceDateEpoch,
      gitCommit: options.gitCommit,
      builder: sshRelayRuntimeBuilderIdentity({ gitCommit: options.gitCommit }),
      runner: sshRelayRuntimeRunnerIdentity(),
      toolchain
    })
    return {
      tuple: options.tuple,
      contentId: identity.contentId,
      archive,
      inspection,
      metadata,
      toolchain,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6
    }
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true })
    throw error
  } finally {
    if (workDirectoryCreated) {
      await rm(workDirectory, { recursive: true, force: true })
    }
  }
}

async function main() {
  const result = await buildSshRelayRuntime(parseBuildArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write(`SSH relay runtime build failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
