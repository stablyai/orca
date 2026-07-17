import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { writeSshRelayRuntimeManifestTupleDescriptor } from './ssh-relay-runtime-manifest-tuple.mjs'
import {
  buildSshRelayRuntimeNativeSigningPlan,
  readSshRelayRuntimeNativeSigningIdentity
} from './ssh-relay-runtime-native-signing-plan.mjs'
import { verifySshRelayRuntime } from './verify-ssh-relay-runtime.mjs'

const MAX_RECEIPT_BYTES = 32 * 1024 * 1024
const PATH_ARGUMENTS = new Map([
  ['--source-output-directory', 'sourceOutputDirectory'],
  ['--identity', 'identityPath'],
  ['--output-directory', 'outputDirectory']
])
const VALUE_ARGUMENTS = new Map([
  ['--verified-at', 'verifiedAt'],
  ['--native-verification-tool-version', 'nativeVerificationToolVersion']
])

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function physicalDirectory(path, label) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime Linux finalization ${label} must be a real directory`)
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
  throw new Error('Runtime Linux finalization requires an exclusive output directory')
}

async function copyRegularFile(source, destination, label) {
  const before = await lstat(source, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n) {
    throw new Error(`Runtime Linux finalization ${label} must be a non-empty regular file`)
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  const after = await lstat(source, { bigint: true })
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`Runtime Linux finalization ${label} changed while copying`)
  }
}

function aggregateAssetNames(identity) {
  if (
    typeof identity.archive?.name !== 'string' ||
    basename(identity.archive.name) !== identity.archive.name
  ) {
    throw new Error('Runtime Linux finalization archive identity is invalid')
  }
  const prefix = `orca-ssh-relay-runtime-${identity.tupleId}`
  return {
    archive: identity.archive.name,
    sbom: `${prefix}.spdx.json`,
    provenance: `${prefix}.provenance.json`
  }
}

function linuxVerificationReport(identity, plan) {
  return {
    tupleId: identity.tupleId,
    sourceContentId: identity.contentId,
    finalContentId: identity.contentId,
    verifiedFiles: plan.verificationFiles.map((file) => ({
      path: file.path,
      role: file.role,
      sha256: file.sourceSha256
    }))
  }
}

async function writeReceipt(path, receipt) {
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error('Runtime Linux finalization receipt exceeds its size limit')
  }
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
}

export async function finalizeSshRelayRuntimeLinuxArtifact({
  sourceOutputDirectory,
  identityPath,
  outputDirectory,
  verifiedAt,
  nativeVerificationTool,
  readIdentityImpl = readSshRelayRuntimeNativeSigningIdentity,
  buildPlanImpl = buildSshRelayRuntimeNativeSigningPlan,
  verifyRuntimeImpl = verifySshRelayRuntime,
  writeDescriptorImpl = writeSshRelayRuntimeManifestTupleDescriptor
}) {
  const source = await physicalDirectory(resolve(sourceOutputDirectory), 'source output')
  const absoluteIdentity = resolve(identityPath)
  const physicalIdentity = await realpath(absoluteIdentity)
  const identity = await readIdentityImpl(physicalIdentity)
  if (identity.os !== 'linux' || !identity.tupleId?.startsWith('linux-')) {
    throw new Error('Runtime Linux finalization accepts only Linux identities')
  }
  const plan = buildPlanImpl(identity)
  if (plan.platform !== 'linux') {
    throw new Error('Runtime Linux finalization signing plan must be hash-only Linux')
  }
  const expectedIdentityPath = join(
    source,
    `orca-ssh-relay-runtime-${identity.tupleId}.identity.json`
  )
  if (physicalIdentity !== expectedIdentityPath) {
    throw new Error('Runtime Linux finalization identity must be the exact source output identity')
  }
  const outputParent = await physicalDirectory(dirname(resolve(outputDirectory)), 'output parent')
  const output = resolve(outputParent, basename(resolve(outputDirectory)))
  if (containsPath(source, output) || containsPath(output, source)) {
    throw new Error('Runtime Linux finalization source and output must be physically disjoint')
  }
  await assertAbsent(output)

  const names = aggregateAssetNames(identity)
  const runtimeDirectory = join(source, 'runtime')
  await physicalDirectory(runtimeDirectory, 'runtime')
  const finalIdentity = { ...identity }
  delete finalIdentity.archive
  let outputCreated = false
  try {
    await mkdir(output)
    outputCreated = true
    const assetsRoot = join(output, 'assets')
    const evidenceRoot = join(output, 'evidence')
    await Promise.all([mkdir(assetsRoot), mkdir(evidenceRoot)])
    for (const [label, name] of Object.entries(names)) {
      await copyRegularFile(join(source, name), join(assetsRoot, name), label)
    }

    const verification = await verifyRuntimeImpl({
      runtimeDirectory,
      identityPath: physicalIdentity,
      archivePath: join(source, names.archive)
    })
    // Why: Linux has no signing mutation, but its complete native hash projection must still be final.
    const verificationReport = linuxVerificationReport(identity, plan)
    const descriptor = await writeDescriptorImpl({
      runtimeRoot: runtimeDirectory,
      inputDirectory: assetsRoot,
      finalIdentity,
      verificationReport,
      nativeVerificationTool,
      verifiedAt
    })
    const receipt = {
      tupleId: identity.tupleId,
      contentId: identity.contentId,
      verification,
      aggregateInput: descriptor.input
    }
    const receiptPath = join(evidenceRoot, `${identity.tupleId}.linux-finalization.json`)
    await writeReceipt(receiptPath, receipt)
    return {
      ...receipt,
      assetsRoot,
      evidenceRoot,
      receiptPath
    }
  } catch (error) {
    if (outputCreated) {
      // Why: an incomplete descriptor set must never become an aggregate candidate.
      await rm(output, { recursive: true, force: true })
    }
    throw error
  }
}

export function parseSshRelayRuntimeLinuxFinalizationArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const field = PATH_ARGUMENTS.get(flag) ?? VALUE_ARGUMENTS.get(flag)
    const value = argv[index + 1]
    if (!field || !value || value.startsWith('--') || result[field]) {
      throw new Error(`Invalid runtime Linux finalization argument: ${flag}`)
    }
    result[field] = PATH_ARGUMENTS.has(flag) ? resolve(value) : value
  }
  for (const field of [...PATH_ARGUMENTS.values(), ...VALUE_ARGUMENTS.values()]) {
    if (!result[field]) {
      throw new Error(`Missing runtime Linux finalization argument: ${field}`)
    }
  }
  return result
}

async function main() {
  const options = parseSshRelayRuntimeLinuxFinalizationArguments(process.argv.slice(2))
  const result = await finalizeSshRelayRuntimeLinuxArtifact({
    ...options,
    nativeVerificationTool: { name: 'node', version: options.nativeVerificationToolVersion }
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`SSH relay runtime Linux finalization failed: ${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
