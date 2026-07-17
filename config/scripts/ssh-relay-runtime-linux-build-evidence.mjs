import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { buildSshRelayRuntime } from './build-ssh-relay-runtime.mjs'
import { verifySshRelayRuntime } from './verify-ssh-relay-runtime.mjs'
import { verifySshRelayRuntimeReproducibility } from './ssh-relay-runtime-reproducibility.mjs'

const scriptDirectory = import.meta.dirname
const defaultContractPath = resolve(scriptDirectory, '..', 'ssh-relay-node-release-v24.18.0.json')
const SUPPORTED_TUPLES = new Set(['linux-x64-glibc', 'linux-arm64-glibc'])

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseSshRelayRuntimeLinuxBuildEvidenceArguments(argv) {
  const result = { contractPath: defaultContractPath }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = valueAfter(argv, index, flag)
    if (flag === '--tuple') {
      result.tuple = value
    } else if (flag === '--inputs-directory') {
      result.inputsDirectory = resolve(value)
    } else if (flag === '--output-root') {
      result.outputRoot = resolve(value)
    } else if (flag === '--work-directory') {
      result.workDirectory = resolve(value)
    } else if (flag === '--evidence-directory') {
      result.evidenceDirectory = resolve(value)
    } else if (flag === '--contract') {
      result.contractPath = resolve(value)
    } else if (flag === '--source-date-epoch') {
      result.sourceDateEpoch = Number(value)
    } else if (flag === '--git-commit') {
      result.gitCommit = value
    } else {
      throw new Error(`Unknown Linux runtime evidence argument: ${flag}`)
    }
    index += 1
  }
  for (const field of [
    'tuple',
    'inputsDirectory',
    'outputRoot',
    'workDirectory',
    'evidenceDirectory',
    'sourceDateEpoch',
    'gitCommit'
  ]) {
    if (result[field] === undefined) {
      throw new Error(`Missing required Linux runtime evidence argument: ${field}`)
    }
  }
  if (!SUPPORTED_TUPLES.has(result.tuple)) {
    throw new Error(`Unsupported Linux runtime evidence tuple: ${result.tuple}`)
  }
  if (!Number.isSafeInteger(result.sourceDateEpoch) || result.sourceDateEpoch < 0) {
    throw new Error('--source-date-epoch must be a non-negative safe integer')
  }
  if (!/^[0-9a-f]{40}$/.test(result.gitCommit)) {
    throw new Error('--git-commit must be a full lowercase SHA-1')
  }
  assertSshRelayRuntimeLinuxEvidenceDirectories(result)
  return result
}

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function assertSshRelayRuntimeLinuxEvidenceDirectories({
  outputRoot,
  workDirectory,
  evidenceDirectory
}) {
  const directories = [outputRoot, workDirectory, evidenceDirectory]
  for (let left = 0; left < directories.length; left += 1) {
    for (let right = left + 1; right < directories.length; right += 1) {
      if (
        containsPath(directories[left], directories[right]) ||
        containsPath(directories[right], directories[left])
      ) {
        throw new Error('Linux runtime evidence directories must be pairwise disjoint')
      }
    }
  }
}

async function createExclusiveDirectory(path) {
  await mkdir(dirname(path), { recursive: true })
  await mkdir(path)
}

async function buildAndVerify(options, label) {
  const outputDirectory = join(options.outputRoot, label)
  const build = await buildSshRelayRuntime({
    tuple: options.tuple,
    inputsDirectory: options.inputsDirectory,
    outputDirectory,
    workDirectory: options.workDirectory,
    contractPath: options.contractPath,
    sourceDateEpoch: options.sourceDateEpoch,
    gitCommit: options.gitCommit
  })
  const verification = await verifySshRelayRuntime({
    runtimeDirectory: join(outputDirectory, 'runtime'),
    identityPath: join(outputDirectory, build.metadata.identity.name),
    archivePath: build.archive.path
  })
  return { label, outputDirectory, build, verification }
}

export async function buildSshRelayRuntimeLinuxEvidence(options) {
  assertSshRelayRuntimeLinuxEvidenceDirectories(options)
  await createExclusiveDirectory(options.outputRoot)
  // Why: both native builds use the same canonical path but the builder removes it between runs.
  const first = await buildAndVerify(options, 'first')
  const second = await buildAndVerify(options, 'second')
  const reproducibility = await verifySshRelayRuntimeReproducibility({
    tuple: options.tuple,
    firstOutputDirectory: first.outputDirectory,
    secondOutputDirectory: second.outputDirectory
  })
  await createExclusiveDirectory(options.evidenceDirectory)
  for (const asset of [
    first.build.archive,
    first.build.metadata.identity,
    first.build.metadata.sbom,
    first.build.metadata.provenance
  ]) {
    const source = asset.path ?? join(first.outputDirectory, asset.name)
    await copyFile(source, join(options.evidenceDirectory, asset.name), constants.COPYFILE_EXCL)
  }
  return {
    tuple: options.tuple,
    first: { build: first.build, verification: first.verification },
    second: { build: second.build, verification: second.verification },
    reproducibility
  }
}

async function main() {
  const result = await buildSshRelayRuntimeLinuxEvidence(
    parseSshRelayRuntimeLinuxBuildEvidenceArguments(process.argv.slice(2))
  )
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write(`SSH relay Linux runtime evidence build failed: ${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
