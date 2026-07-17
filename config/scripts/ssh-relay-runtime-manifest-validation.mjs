import { z } from 'zod'

import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'

const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024
const MAX_EXPANDED_SIZE = 350 * 1024 * 1024
const MAX_FILE_SIZE = 250 * 1024 * 1024
const MAX_ENTRIES = 5_000
const MAX_PATH_BYTES = 240
const MAX_PATH_DEPTH = 32
const VERSION = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u
const NUMERIC_VERSION = /^\d+\.\d+(?:\.\d+)?$/u
const OPENSSH_VERSION = /^\d+\.\d+p\d+$/u
const ASSET_NAME = /^[A-Za-z0-9._-]+$/u
const PORTABLE_PATH = /^[A-Za-z0-9._@+/-]+$/u
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u)
const safeSizeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const versionSchema = z.string().regex(VERSION).max(64)
const numericVersionSchema = z.string().regex(NUMERIC_VERSION).max(64)
const timestampSchema = z
  .string()
  .regex(TIMESTAMP)
  .refine(
    (value) => {
      const milliseconds = Date.parse(value)
      return !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === value
    },
    { message: 'invalid canonical UTC timestamp' }
  )

const directoryEntrySchema = z
  .object({ path: z.string(), type: z.literal('directory'), mode: z.literal(0o755) })
  .strict()
const fileEntrySchema = z
  .object({
    path: z.string(),
    type: z.literal('file'),
    role: z.enum([
      'node',
      'relay',
      'relay-watcher',
      'node-pty-native',
      'parcel-watcher-native',
      'native-runtime',
      'runtime-javascript',
      'license'
    ]),
    size: safeSizeSchema.max(MAX_FILE_SIZE),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
    sha256: digestSchema
  })
  .strict()
const entrySchema = z.discriminatedUnion('type', [directoryEntrySchema, fileEntrySchema])

const glibcSchema = z
  .object({
    family: z.literal('glibc'),
    minimumVersion: numericVersionSchema,
    minimumLibstdcxxVersion: numericVersionSchema,
    minimumGlibcxxVersion: numericVersionSchema
  })
  .strict()
const muslSchema = z
  .object({
    family: z.literal('musl'),
    minimumVersion: numericVersionSchema,
    minimumLibstdcxxVersion: z.null(),
    minimumGlibcxxVersion: z.null()
  })
  .strict()
const compatibilitySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('linux'),
      minimumKernelVersion: numericVersionSchema,
      libc: z.discriminatedUnion('family', [glibcSchema, muslSchema])
    })
    .strict(),
  z.object({ kind: z.literal('darwin'), minimumVersion: numericVersionSchema }).strict(),
  z
    .object({
      kind: z.literal('windows'),
      minimumBuild: safeSizeSchema,
      minimumOpenSshVersion: z.string().regex(OPENSSH_VERSION).max(64),
      minimumPowerShellVersion: numericVersionSchema,
      minimumDotNetFrameworkRelease: safeSizeSchema
    })
    .strict()
])

const metadataAssetSchema = z
  .object({ name: z.string().regex(ASSET_NAME), size: safeSizeSchema, sha256: digestSchema })
  .strict()
const nativeVerificationSchema = z
  .object({
    policy: z.enum(['linux-hash-only-v1', 'apple-developer-id-v1', 'signpath-authenticode-v1']),
    tool: z
      .object({
        name: z.string().regex(ASSET_NAME),
        version: z
          .string()
          .regex(/^[\x20-\x7e]+$/u)
          .max(64)
      })
      .strict(),
    verifiedAt: timestampSchema,
    files: z
      .array(z.object({ path: z.string(), sha256: digestSchema }).strict())
      .min(1)
      .max(MAX_ENTRIES)
  })
  .strict()

const tupleSchema = z
  .object({
    tupleId: z.enum([
      'linux-x64-glibc',
      'linux-arm64-glibc',
      'linux-x64-musl',
      'linux-arm64-musl',
      'darwin-x64',
      'darwin-arm64',
      'win32-x64',
      'win32-arm64'
    ]),
    os: z.enum(['linux', 'darwin', 'win32']),
    architecture: z.enum(['x64', 'arm64']),
    compatibility: compatibilitySchema,
    nodeVersion: versionSchema,
    dependencies: z
      .object({ nodePtyVersion: versionSchema, parcelWatcherVersion: versionSchema })
      .strict(),
    entries: z.array(entrySchema).min(1).max(MAX_ENTRIES),
    contentId: digestSchema,
    archive: z
      .object({
        name: z.string().regex(ASSET_NAME),
        size: safeSizeSchema.max(MAX_ARCHIVE_SIZE),
        expandedSize: safeSizeSchema.max(MAX_EXPANDED_SIZE),
        fileCount: safeSizeSchema.max(MAX_ENTRIES),
        sha256: digestSchema
      })
      .strict(),
    metadataAssets: z
      .object({ sbom: metadataAssetSchema, provenance: metadataAssetSchema })
      .strict(),
    nativeVerification: nativeVerificationSchema
  })
  .strict()

const unsignedManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    build: z
      .object({
        tag: z.string().max(64),
        channel: z.enum(['stable', 'rc', 'perf']),
        version: z.string().max(64),
        relayProtocolVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
      })
      .strict(),
    createdAt: timestampSchema,
    tuples: z.array(tupleSchema).min(1).max(8)
  })
  .strict()

function assertSafePath(path) {
  if (!path || Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES || !PORTABLE_PATH.test(path)) {
    throw new Error(`SSH relay runtime manifest contains an unsafe artifact path: ${path}`)
  }
  const segments = path.split('/')
  if (path.startsWith('/') || segments.length > MAX_PATH_DEPTH) {
    throw new Error(`SSH relay runtime manifest contains an unsafe artifact path: ${path}`)
  }
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      WINDOWS_DEVICE_NAME.test(segment)
    ) {
      throw new Error(`SSH relay runtime manifest contains an unsafe artifact path: ${path}`)
    }
  }
}

function expectedTupleId(tuple) {
  if (tuple.os === 'linux' && tuple.compatibility.kind === 'linux') {
    return `linux-${tuple.architecture}-${tuple.compatibility.libc.family}`
  }
  return `${tuple.os}-${tuple.architecture}`
}

function expectedArchiveName(tuple) {
  const extension = tuple.os === 'win32' ? 'zip' : 'tar.br'
  return `orca-ssh-relay-runtime-v1-${tuple.tupleId}-${tuple.contentId.slice(7)}.${extension}`
}

function assertTupleEntries(tuple) {
  const exactPaths = new Set()
  const foldedPaths = new Set()
  const directories = new Set()
  for (const entry of tuple.entries) {
    assertSafePath(entry.path)
    const folded = entry.path.toLowerCase()
    if (exactPaths.has(entry.path) || foldedPaths.has(folded)) {
      throw new Error(`SSH relay runtime manifest has a colliding path: ${entry.path}`)
    }
    exactPaths.add(entry.path)
    foldedPaths.add(folded)
    if (entry.type === 'directory') {
      directories.add(entry.path)
    }
  }
  for (const entry of tuple.entries) {
    const separator = entry.path.lastIndexOf('/')
    if (separator > 0 && !directories.has(entry.path.slice(0, separator))) {
      throw new Error(`SSH relay runtime manifest has an undeclared parent: ${entry.path}`)
    }
  }

  const files = tuple.entries.filter((entry) => entry.type === 'file')
  const expectedPaths = new Map([
    ['node', tuple.os === 'win32' ? 'bin/node.exe' : 'bin/node'],
    ['relay', 'relay.js'],
    ['relay-watcher', 'relay-watcher.js']
  ])
  for (const role of ['node', 'relay', 'relay-watcher', 'parcel-watcher-native']) {
    const matching = files.filter((entry) => entry.role === role)
    if (
      matching.length !== 1 ||
      (expectedPaths.has(role) && matching[0].path !== expectedPaths.get(role))
    ) {
      throw new Error(`SSH relay runtime manifest requires one valid ${role} entry`)
    }
  }
  const nativePaths =
    tuple.os === 'win32'
      ? {
          'node-pty-native': [
            'node_modules/node-pty/build/Release/conpty.node',
            'node_modules/node-pty/build/Release/conpty_console_list.node'
          ],
          'native-runtime': [
            'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
            'node_modules/node-pty/build/Release/conpty/conpty.dll'
          ]
        }
      : {
          'node-pty-native': ['node_modules/node-pty/build/Release/pty.node'],
          'native-runtime':
            tuple.os === 'darwin' ? ['node_modules/node-pty/build/Release/spawn-helper'] : []
        }
  for (const [role, expected] of Object.entries(nativePaths)) {
    const actual = files
      .filter((entry) => entry.role === role)
      .map((entry) => entry.path)
      .sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`SSH relay runtime manifest has invalid ${role} closure`)
    }
  }
  if (
    !files.some((entry) => entry.path === 'node_modules/node-pty/package.json') ||
    !files.some((entry) => entry.path === 'node_modules/@parcel/watcher/package.json') ||
    !files.some((entry) => entry.role === 'license')
  ) {
    throw new Error('SSH relay runtime manifest is missing required package or license content')
  }
  if (files.find((entry) => entry.role === 'node').mode !== 0o755) {
    throw new Error('SSH relay runtime manifest bundled Node must be executable')
  }
  return files
}

function assertNativeVerification(tuple, files) {
  const watcherPackage =
    tuple.os === 'linux' && tuple.compatibility.kind === 'linux'
      ? `node_modules/@parcel/watcher-linux-${tuple.architecture}-${tuple.compatibility.libc.family}`
      : `node_modules/@parcel/watcher-${tuple.os}-${tuple.architecture}`
  for (const entry of tuple.entries) {
    if (
      entry.path.startsWith('node_modules/@parcel/watcher-') &&
      entry.path !== watcherPackage &&
      !entry.path.startsWith(`${watcherPackage}/`)
    ) {
      throw new Error('SSH relay runtime manifest contains an extra native watcher package')
    }
  }
  const expectedPolicy =
    tuple.os === 'linux'
      ? 'linux-hash-only-v1'
      : tuple.os === 'darwin'
        ? 'apple-developer-id-v1'
        : 'signpath-authenticode-v1'
  if (tuple.nativeVerification.policy !== expectedPolicy) {
    throw new Error('SSH relay runtime manifest has the wrong native verification policy')
  }

  const attested = new Map()
  for (const file of tuple.nativeVerification.files) {
    assertSafePath(file.path)
    if (attested.has(file.path)) {
      throw new Error(`SSH relay runtime manifest has duplicate native attestation: ${file.path}`)
    }
    attested.set(file.path, file.sha256)
  }
  const nativeRoles = new Set([
    'node',
    'node-pty-native',
    'parcel-watcher-native',
    'native-runtime'
  ])
  for (const file of files) {
    if (nativeRoles.has(file.role) && attested.get(file.path) !== file.sha256) {
      throw new Error(`SSH relay runtime manifest has an invalid attested hash: ${file.path}`)
    }
  }
  for (const [path, sha256] of attested) {
    const file = files.find((entry) => entry.path === path)
    if (!file || file.sha256 !== sha256) {
      throw new Error(`SSH relay runtime manifest attests missing or mismatched content: ${path}`)
    }
  }
}

function assertTupleConsistency(tuple) {
  const compatibilityKind = tuple.os === 'win32' ? 'windows' : tuple.os
  if (expectedTupleId(tuple) !== tuple.tupleId || tuple.compatibility.kind !== compatibilityKind) {
    throw new Error(`SSH relay runtime manifest tuple identity is inconsistent: ${tuple.tupleId}`)
  }
  const files = assertTupleEntries(tuple)
  assertNativeVerification(tuple, files)
  const expandedSize = files.reduce((total, entry) => total + entry.size, 0)
  if (tuple.archive.fileCount !== files.length || tuple.archive.expandedSize !== expandedSize) {
    throw new Error(`SSH relay runtime manifest archive metadata is inconsistent: ${tuple.tupleId}`)
  }
  if (tuple.contentId !== computeSshRelayRuntimeContentId(tuple)) {
    throw new Error(`SSH relay runtime manifest content identity is inconsistent: ${tuple.tupleId}`)
  }
  if (tuple.archive.name !== expectedArchiveName(tuple)) {
    throw new Error(`SSH relay runtime manifest archive name is inconsistent: ${tuple.tupleId}`)
  }
  const metadataPrefix = `orca-ssh-relay-runtime-${tuple.tupleId}`
  if (
    tuple.metadataAssets.sbom.name !== `${metadataPrefix}.spdx.json` ||
    tuple.metadataAssets.provenance.name !== `${metadataPrefix}.provenance.json`
  ) {
    throw new Error(
      `SSH relay runtime manifest metadata asset name is inconsistent: ${tuple.tupleId}`
    )
  }
}

export function parseSshRelayRuntimeManifestTuple(input) {
  const parsed = tupleSchema.parse(input)
  assertTupleConsistency(parsed)
  return parsed
}

function parseReleaseTag(tag) {
  for (const [pattern, channel] of [
    [/^v(\d+\.\d+\.\d+)$/u, 'stable'],
    [/^v(\d+\.\d+\.\d+-rc\.\d+)$/u, 'rc'],
    [/^v(\d+\.\d+\.\d+-rc\.\d+\.perf)$/u, 'perf']
  ]) {
    const match = pattern.exec(tag)
    if (match) {
      return { channel, version: match[1] }
    }
  }
  throw new Error('SSH relay runtime manifest release tag is invalid')
}

export function parseSshRelayRuntimeUnsignedManifest(input) {
  const parsed = unsignedManifestSchema.parse(input)
  const release = parseReleaseTag(parsed.build.tag)
  if (release.channel !== parsed.build.channel || release.version !== parsed.build.version) {
    throw new Error('SSH relay runtime manifest build identity does not match its exact release')
  }
  const tupleIds = new Set()
  for (const tuple of parsed.tuples) {
    if (tupleIds.has(tuple.tupleId)) {
      throw new Error(`SSH relay runtime manifest has a duplicate tuple: ${tuple.tupleId}`)
    }
    tupleIds.add(tuple.tupleId)
    parseSshRelayRuntimeManifestTuple(tuple)
  }
  return parsed
}
