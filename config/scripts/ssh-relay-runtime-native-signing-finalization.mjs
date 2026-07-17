import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createSshRelayRuntimeArchive } from './ssh-relay-runtime-archive.mjs'
import { writeSshRelayRuntimeManifestTupleDescriptor } from './ssh-relay-runtime-manifest-tuple.mjs'
import { verifySshRelayRuntimeMacosSignatures } from './ssh-relay-runtime-macos-signature-verification.mjs'
import { applySshRelayRuntimeNativeSigningReturn } from './ssh-relay-runtime-native-signing-apply.mjs'
import { readSshRelayRuntimeNativeSigningIdentity } from './ssh-relay-runtime-native-signing-plan.mjs'
import { readSshRelayRuntimeNativeSigningStageReport } from './ssh-relay-runtime-native-signing-stage-report.mjs'
import {
  verifySshRelayRuntimePostSignMetadata,
  writeSshRelayRuntimePostSignMetadata
} from './ssh-relay-runtime-post-sign-metadata.mjs'
import { sshRelayRuntimeRunnerIdentity } from './ssh-relay-runtime-toolchain.mjs'
import { verifySshRelayRuntimeWindowsSignatures } from './ssh-relay-runtime-windows-signature-verification.mjs'
import { verifySshRelayRuntime } from './verify-ssh-relay-runtime.mjs'

const FINALIZATION_TIMEOUT_MS = 20 * 60_000
const MAX_JSON_BYTES = 32 * 1024 * 1024
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function physicalDirectory(path, label) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime native signing finalization ${label} must be a real directory`)
  }
  return realpath(path)
}

async function assertAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error('Runtime native signing finalization requires an exclusive output directory')
}

async function finalizationRoots(sourceRuntimeRoot, returnedRoot, outputDirectory) {
  const absoluteOutput = resolve(outputDirectory)
  const [source, returned, outputParent] = await Promise.all([
    physicalDirectory(resolve(sourceRuntimeRoot), 'source root'),
    physicalDirectory(resolve(returnedRoot), 'returned root'),
    physicalDirectory(dirname(absoluteOutput), 'output parent')
  ])
  const output = resolve(outputParent, basename(absoluteOutput))
  for (const root of [source, returned]) {
    if (containsPath(root, output) || containsPath(output, root)) {
      throw new Error('Runtime native signing finalization roots must be physically disjoint')
    }
  }
  await assertAbsent(output)
  return { source, returned, output }
}

async function writeJsonExclusive(path, value, signal) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_JSON_BYTES) {
    throw new Error('Runtime native signing finalization JSON exceeds its size bound')
  }
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600, signal })
}

async function defaultNativeVerification({
  runtimeRoot,
  sourceIdentity,
  finalIdentity,
  selection,
  expectedOrcaTeamIdentifier
}) {
  if (sourceIdentity.os === 'darwin') {
    return verifySshRelayRuntimeMacosSignatures({
      runtimeRoot,
      sourceIdentity,
      finalIdentity,
      selection,
      expectedOrcaTeamIdentifier
    })
  }
  if (sourceIdentity.os === 'win32') {
    return verifySshRelayRuntimeWindowsSignatures({
      runtimeRoot,
      sourceIdentity,
      finalIdentity,
      selection
    })
  }
  throw new Error(
    `Runtime native signing finalization rejects unsigned platform: ${sourceIdentity.os}`
  )
}

export async function finalizeSshRelayRuntimeNativeSigning({
  sourceRuntimeRoot,
  returnedRoot,
  outputDirectory,
  sourceIdentity,
  selection,
  expectedOrcaTeamIdentifier,
  nodeRelease,
  sourceDateEpoch,
  gitCommit,
  builder,
  runner,
  toolchain,
  nativeVerificationTool,
  verifiedAt,
  signal,
  verifyNativeImpl = defaultNativeVerification,
  smokeImpl = verifySshRelayRuntime
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FINALIZATION_TIMEOUT_MS)])
    : AbortSignal.timeout(FINALIZATION_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  if (!GIT_COMMIT_PATTERN.test(gitCommit ?? '')) {
    throw new Error('Runtime native signing finalization requires an exact source commit')
  }
  const roots = await finalizationRoots(sourceRuntimeRoot, returnedRoot, outputDirectory)
  let outputCreated = false
  try {
    await mkdir(roots.output)
    outputCreated = true
    const runtimeRoot = join(roots.output, 'runtime')
    const evidenceRoot = join(roots.output, 'evidence')
    const assetsRoot = join(roots.output, 'assets')
    await mkdir(evidenceRoot)
    const applied = await applySshRelayRuntimeNativeSigningReturn({
      sourceRuntimeRoot: roots.source,
      returnedRoot: roots.returned,
      outputRuntimeRoot: runtimeRoot,
      identity: sourceIdentity,
      selection
    })
    const identityPath = join(evidenceRoot, `${sourceIdentity.tupleId}.final-identity.json`)
    await writeJsonExclusive(identityPath, applied.identity, effectiveSignal)
    const nativeVerification = await verifyNativeImpl({
      runtimeRoot,
      sourceIdentity,
      finalIdentity: applied.identity,
      selection,
      expectedOrcaTeamIdentifier
    })
    // Why: native code is trusted only after full-tree hashing and before PTY/watcher execution.
    const smoke = await smokeImpl({ runtimeDirectory: runtimeRoot, identityPath })
    await mkdir(assetsRoot)
    const archive = await createSshRelayRuntimeArchive({
      runtimeRoot,
      outputDirectory: assetsRoot,
      identity: applied.identity,
      sourceDateEpoch,
      signal: effectiveSignal
    })
    const metadata = await writeSshRelayRuntimePostSignMetadata({
      runtimeRoot,
      outputDirectory: assetsRoot,
      finalIdentity: applied.identity,
      archive,
      nodeRelease,
      sourceDateEpoch,
      gitCommit,
      builder,
      runner,
      toolchain,
      signal: effectiveSignal
    })
    const tuple = await writeSshRelayRuntimeManifestTupleDescriptor({
      runtimeRoot,
      inputDirectory: assetsRoot,
      finalIdentity: applied.identity,
      verificationReport: nativeVerification,
      nativeVerificationTool,
      verifiedAt,
      signal: effectiveSignal
    })
    const result = {
      tupleId: sourceIdentity.tupleId,
      sourceContentId: sourceIdentity.contentId,
      finalContentId: applied.identity.contentId,
      returnedFiles: applied.returnedFiles,
      nativeVerification,
      smoke,
      metadata,
      aggregateInput: tuple.input
    }
    await writeJsonExclusive(
      join(evidenceRoot, `${sourceIdentity.tupleId}.native-verification.json`),
      nativeVerification,
      effectiveSignal
    )
    await writeJsonExclusive(
      join(evidenceRoot, `${sourceIdentity.tupleId}.finalization.json`),
      result,
      effectiveSignal
    )
    return { ...result, runtimeRoot, assetsRoot, evidenceRoot }
  } catch (error) {
    if (outputCreated) {
      // Why: partial signed outputs must never survive for aggregation or retry reuse.
      await rm(roots.output, { recursive: true, force: true })
    }
    throw error
  }
}

async function readJson(path, label) {
  const metadata = await lstat(path)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_JSON_BYTES
  ) {
    throw new Error(`Runtime native signing finalization ${label} must be bounded JSON`)
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `Runtime native signing finalization ${label} is invalid JSON: ${error.message}`
    )
  }
}

function sourceProvenanceInputs(provenance, sourceIdentity, gitCommit) {
  const definition = provenance.predicate?.buildDefinition
  const parameters = definition?.externalParameters
  const dependencies = definition?.resolvedDependencies
  const expectedGit = `git+https://github.com/stablyai/orca@${gitCommit}`
  const gitInputs = Array.isArray(dependencies)
    ? dependencies.filter(
        (entry) => entry?.uri === expectedGit && entry?.digest?.gitCommit === gitCommit
      )
    : []
  if (
    parameters?.contentId !== sourceIdentity.contentId ||
    !Number.isSafeInteger(parameters?.sourceDateEpoch) ||
    gitInputs.length !== 1
  ) {
    throw new Error('Runtime native signing finalization source provenance is inconsistent')
  }
  return {
    sourceDateEpoch: parameters.sourceDateEpoch,
    toolchain: definition.internalParameters?.toolchain
  }
}

function signingBuilder(gitCommit, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') {
    return `local://ssh-relay-runtime-native-signing/${process.platform}/${process.arch}`
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('Runtime native signing finalization GitHub repository is invalid')
  }
  return `https://github.com/${env.GITHUB_REPOSITORY}/blob/${gitCommit}/.github/workflows/ssh-relay-runtime-native-signing.yml`
}

const PATH_ARGUMENTS = new Map([
  ['--identity', 'identityPath'],
  ['--source-runtime-directory', 'sourceRuntimeRoot'],
  ['--returned-directory', 'returnedRoot'],
  ['--signing-stage-report', 'stageReportPath'],
  ['--source-archive', 'sourceArchivePath'],
  ['--source-sbom', 'sourceSbomPath'],
  ['--source-provenance', 'sourceProvenancePath'],
  ['--output-directory', 'outputDirectory'],
  ['--node-release', 'nodeReleasePath']
])
const VALUE_ARGUMENTS = new Map([
  ['--git-commit', 'gitCommit'],
  ['--expected-macos-team-identifier', 'expectedOrcaTeamIdentifier'],
  ['--native-verification-tool-version', 'nativeVerificationToolVersion'],
  ['--verified-at', 'verifiedAt']
])

export function parseSshRelayRuntimeNativeSigningFinalizationArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = PATH_ARGUMENTS.get(flag) ?? VALUE_ARGUMENTS.get(flag)
    const value = argv[index + 1]
    if (!field || !value || value.startsWith('--') || result[field]) {
      throw new Error(`Invalid runtime native signing finalization argument: ${flag}`)
    }
    result[field] = PATH_ARGUMENTS.has(flag) ? resolve(value) : value
  }
  const required = [
    ...PATH_ARGUMENTS.values(),
    'gitCommit',
    'nativeVerificationToolVersion',
    'verifiedAt'
  ]
  for (const field of required) {
    if (!result[field]) {
      throw new Error(`Missing runtime native signing finalization argument: ${field}`)
    }
  }
  return result
}

async function main() {
  const options = parseSshRelayRuntimeNativeSigningFinalizationArguments(process.argv.slice(2))
  const sourceIdentity = await readSshRelayRuntimeNativeSigningIdentity(options.identityPath)
  if (sourceIdentity.os === 'darwin' && !options.expectedOrcaTeamIdentifier) {
    throw new Error('Runtime macOS finalization requires the expected Orca team identifier')
  }
  const [{ selection }, nodeRelease, sourceProvenance] = await Promise.all([
    readSshRelayRuntimeNativeSigningStageReport(options.stageReportPath, sourceIdentity),
    readJson(options.nodeReleasePath, 'Node release'),
    readJson(options.sourceProvenancePath, 'source provenance')
  ])
  const finalIdentity = { ...sourceIdentity }
  delete finalIdentity.archive
  await verifySshRelayRuntimePostSignMetadata({
    finalIdentity,
    archive: { ...sourceIdentity.archive, path: options.sourceArchivePath },
    sbomPath: options.sourceSbomPath,
    provenancePath: options.sourceProvenancePath
  })
  const provenanceInputs = sourceProvenanceInputs(
    sourceProvenance,
    sourceIdentity,
    options.gitCommit
  )
  const platformTool = sourceIdentity.os === 'darwin' ? 'codesign' : 'Get-AuthenticodeSignature'
  const result = await finalizeSshRelayRuntimeNativeSigning({
    ...options,
    ...provenanceInputs,
    sourceIdentity,
    selection,
    nodeRelease,
    builder: signingBuilder(options.gitCommit),
    runner: sshRelayRuntimeRunnerIdentity(),
    nativeVerificationTool: {
      name: platformTool,
      version: options.nativeVerificationToolVersion
    }
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `SSH relay runtime native signing finalization failed: ${error.stack ?? error}\n`
    )
    process.exitCode = 1
  })
}

export const SSH_RELAY_RUNTIME_NATIVE_SIGNING_FINALIZATION_LIMITS = Object.freeze({
  maximumJsonBytes: MAX_JSON_BYTES,
  timeoutMs: FINALIZATION_TIMEOUT_MS
})
