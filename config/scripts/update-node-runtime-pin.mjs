#!/usr/bin/env node
// Regenerates the pinned asset table in src/shared/node-runtime-pin.ts. Needs network; CI never runs it.
// Usage: node config/scripts/update-node-runtime-pin.mjs --version 24.21.0 [--work-dir DIR] [--keyring FILE]

import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import {
  COMPAT_SERVER_TARGETS,
  SERVER_TARGETS,
  nodeRuntimeExecutablePath,
  nodeRuntimeReleaseUrl
} from '../../src/shared/node-runtime-pin.ts'
import { currentTarget } from './server-build-target.mjs'
import { nodeDistArchiveName, windowsImportLibFile } from './node-dist-archive-name.mjs'
import { runProcessSync } from '@orca/process-host'
import { getTarProgram, getZipExtractorCommand } from './zip-extractor-command.mjs'

const root = resolve(import.meta.dirname, '../..')
const PIN_FILE = join(root, 'src/shared/node-runtime-pin.ts')
const GENERATED_BEGIN = '// @generated-begin by config/scripts/update-node-runtime-pin.mjs'
const GENERATED_END = '// @generated-end'
const RELEASE_KEYRING_URL =
  'https://raw.githubusercontent.com/nodejs/release-keys/HEAD/gpg/pubring.kbx'

const WINDOWS_TARGETS = SERVER_TARGETS.filter((target) => target.startsWith('win32-'))

/** SHASUMS256.txt is signature-verified before this runs, so its node.lib hashes are trusted as-is. */
export function pinWindowsImportLibs(officialHashes) {
  const libs = {}
  for (const target of WINDOWS_TARGETS) {
    const file = windowsImportLibFile(target)
    const sha256 = officialHashes.get(file)
    if (!sha256) {
      throw new Error(`SHASUMS256.txt lists no ${file}`)
    }
    libs[target] = { file, sha256 }
  }
  return libs
}

export function parseShasums(text) {
  const hashes = new Map()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim())
    if (match) {
      hashes.set(match[2], match[1])
    }
  }
  return hashes
}

/** Official builds win over unofficial ones when both publish the same archive. */
export function selectAssetSource(archive, officialHashes, unofficialHashes) {
  if (officialHashes.has(archive)) {
    return { source: 'official', archiveSha256: officialHashes.get(archive) }
  }
  if (unofficialHashes.has(archive)) {
    return { source: 'unofficial', archiveSha256: unofficialHashes.get(archive) }
  }
  return null
}

export function parseNodeApiVersion(nodeVersionHeader) {
  const match = /#define NODE_API_SUPPORTED_VERSION_MAX (\d+)/.exec(nodeVersionHeader)
  if (!match) {
    throw new Error('node_version.h has no NODE_API_SUPPORTED_VERSION_MAX')
  }
  return Number(match[1])
}

function renderAssetTable(name, type, targets, assets) {
  const lines = [`export const ${name}: Record<${type}, NodeRuntimeAsset> = {`]
  targets.forEach((target, index) => {
    const asset = assets[target]
    lines.push(
      `  '${target}': {`,
      `    source: '${asset.source}',`,
      `    archive: '${asset.archive}',`,
      `    archiveSha256: '${asset.archiveSha256}',`,
      `    executableSha256: '${asset.executableSha256}',`,
      `    executableSize: ${asset.executableSize}`,
      index === targets.length - 1 ? '  }' : '  },'
    )
  })
  lines.push('}')
  return lines
}

export function renderGeneratedBlock(pin, assets, compatAssets) {
  const lines = [
    GENERATED_BEGIN,
    'export const NODE_RUNTIME_PIN: NodeRuntimePin = {',
    `  version: '${pin.version}',`,
    `  electron: '${pin.electron}',`,
    `  napi: ${pin.napi},`,
    '  headers: {',
    `    file: '${pin.headers.file}',`,
    `    sha256: '${pin.headers.sha256}'`,
    '  },',
    '  windowsImportLibs: {',
    ...WINDOWS_TARGETS.flatMap((target, index) => [
      `    '${target}': {`,
      `      file: '${pin.windowsImportLibs[target].file}',`,
      `      sha256: '${pin.windowsImportLibs[target].sha256}'`,
      index === WINDOWS_TARGETS.length - 1 ? '    }' : '    },'
    ]),
    '  }',
    '}',
    '',
    ...renderAssetTable('NODE_RUNTIME_ASSETS', 'ServerTarget', SERVER_TARGETS, assets),
    '',
    ...renderAssetTable(
      'NODE_RUNTIME_COMPAT_ASSETS',
      'CompatServerTarget',
      COMPAT_SERVER_TARGETS,
      compatAssets
    ),
    GENERATED_END
  ]
  return lines.join('\n')
}

export function replaceGeneratedBlock(source, block) {
  const begin = source.indexOf(GENERATED_BEGIN)
  const end = source.indexOf(GENERATED_END)
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('node-runtime-pin.ts is missing its @generated markers')
  }
  return source.slice(0, begin) + block + source.slice(end + GENERATED_END.length)
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  return response.text()
}

export async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function run(program, args) {
  const result = runProcessSync({ program, args, timeoutMs: 300_000 })
  if (result.code !== 0) {
    throw new Error(
      `${program} ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`
    )
  }
  return result.stdout
}

export function extract(archivePath, destination, member) {
  mkdirSync(destination, { recursive: true })
  if (archivePath.endsWith('.zip')) {
    const command = getZipExtractorCommand(archivePath, destination)
    run(command.file, command.args)
    return
  }
  run(getTarProgram(), ['-xzf', archivePath, '-C', destination, member])
}

function gpgAvailable() {
  try {
    return runProcessSync({ program: 'gpg', args: ['--version'], timeoutMs: 10_000 }).code === 0
  } catch {
    return false
  }
}

async function verifyOfficialShasums(version, workDir, shasumsPath) {
  if (!gpgAvailable()) {
    console.warn(
      '\n!!! WARNING: gpg is not installed, so SHASUMS256.txt was NOT signature-verified.\n' +
        '!!! Its hashes are trusted over TLS only. Install gpg and rerun before committing a pin.\n'
    )
    return false
  }
  const signaturePath = join(workDir, 'SHASUMS256.txt.sig')
  await download(nodeRuntimeReleaseUrl('official', 'SHASUMS256.txt.sig', version), signaturePath)
  let keyring = argument('--keyring')
  if (!keyring) {
    keyring = join(workDir, 'nodejs-release-keys.kbx')
    try {
      await download(RELEASE_KEYRING_URL, keyring)
    } catch (error) {
      console.warn(
        `\n!!! WARNING: could not fetch Node release keys (${error.message}); ` +
          'SHASUMS256.txt was NOT signature-verified.\n'
      )
      return false
    }
  }
  const gnupgHome = join(workDir, 'gnupg')
  mkdirSync(gnupgHome, { recursive: true, mode: 0o700 })
  const result = runProcessSync({
    program: 'gpg',
    args: [
      '--homedir',
      gnupgHome,
      '--no-default-keyring',
      '--keyring',
      resolve(keyring),
      '--verify',
      signaturePath,
      shasumsPath
    ],
    timeoutMs: 60_000
  })
  if (result.code !== 0) {
    throw new Error(`SHASUMS256.txt signature verification failed:\n${result.stderr}`)
  }
  console.log('Verified SHASUMS256.txt signature against the Node.js release keys.')
  return true
}

async function pinTarget({ version, napi, target, workDir, officialHashes, unofficialHashes }) {
  const archive = nodeDistArchiveName(version, target)
  const selected = selectAssetSource(archive, officialHashes, unofficialHashes)
  if (!selected) {
    // Why fail: a bump must not ship with a target that has no runtime (design D1 risks).
    throw new Error(`No published ${archive} for ${target}; the pin cannot move to ${version}`)
  }
  const archivePath = join(workDir, archive)
  await download(nodeRuntimeReleaseUrl(selected.source, archive, version), archivePath)
  const actual = await sha256File(archivePath)
  if (actual !== selected.archiveSha256) {
    throw new Error(`${archive} hash ${actual} does not match SHASUMS ${selected.archiveSha256}`)
  }
  const member = nodeRuntimeExecutablePath(target, archive)
  const extracted = join(workDir, `extract-${target}`)
  extract(archivePath, extracted, member)
  const executablePath = join(extracted, member)
  const asset = {
    source: selected.source,
    archive,
    archiveSha256: selected.archiveSha256,
    executableSha256: await sha256File(executablePath),
    executableSize: statSync(executablePath).size
  }
  if (target === currentTarget()) {
    const reported = run(executablePath, [
      '-p',
      '`${process.version} ${process.versions.napi}`'
    ]).trim()
    if (reported !== `v${version} ${napi}`) {
      throw new Error(`${member} reports ${reported}, expected v${version} ${napi}`)
    }
  }
  rmSync(extracted, { recursive: true, force: true })
  rmSync(archivePath, { force: true })
  console.log(`${target}: ${asset.source} ${archive} (${asset.executableSize} bytes)`)
  return asset
}

async function pinHeaders(version, workDir, officialHashes) {
  const file = `node-v${version}-headers.tar.gz`
  const sha256 = officialHashes.get(file)
  if (!sha256) {
    throw new Error(`SHASUMS256.txt lists no ${file}`)
  }
  const archivePath = join(workDir, file)
  await download(nodeRuntimeReleaseUrl('official', file, version), archivePath)
  const actual = await sha256File(archivePath)
  if (actual !== sha256) {
    throw new Error(`${file} hash ${actual} does not match SHASUMS ${sha256}`)
  }
  const member = `node-v${version}/include/node/node_version.h`
  const extracted = join(workDir, 'extract-headers')
  extract(archivePath, extracted, member)
  const napi = parseNodeApiVersion(readFileSync(join(extracted, member), 'utf8'))
  return { headers: { file, sha256 }, napi }
}

function pinnedElectronVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declared = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
  if (!/^\d+\.\d+\.\d+$/.test(declared ?? '')) {
    throw new Error(`package.json must pin an exact electron version, found ${declared}`)
  }
  return declared
}

async function main() {
  const version = argument('--version')
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error('Usage: update-node-runtime-pin.mjs --version <major.minor.patch>')
  }
  const workParent = argument('--work-dir') ?? tmpdir()
  mkdirSync(workParent, { recursive: true })
  const workDir = mkdtempSync(join(workParent, 'orca-node-runtime-pin-'))
  try {
    const shasumsPath = join(workDir, 'SHASUMS256.txt')
    await download(nodeRuntimeReleaseUrl('official', 'SHASUMS256.txt', version), shasumsPath)
    await verifyOfficialShasums(version, workDir, shasumsPath)
    const officialHashes = parseShasums(readFileSync(shasumsPath, 'utf8'))
    const unofficialHashes = parseShasums(
      await fetchText(nodeRuntimeReleaseUrl('unofficial', 'SHASUMS256.txt', version))
    )
    const { headers, napi } = await pinHeaders(version, workDir, officialHashes)
    const assets = {}
    for (const target of SERVER_TARGETS) {
      assets[target] = await pinTarget({
        version,
        napi,
        target,
        workDir,
        officialHashes,
        unofficialHashes
      })
    }
    // Why unofficial only: nodejs.org publishes no glibc 2.17 build; selectAssetSource finds it.
    const compatAssets = {}
    for (const target of COMPAT_SERVER_TARGETS) {
      compatAssets[target] = await pinTarget({
        version,
        napi,
        target,
        workDir,
        officialHashes,
        unofficialHashes
      })
    }
    const pin = {
      version,
      electron: pinnedElectronVersion(),
      napi,
      headers,
      windowsImportLibs: pinWindowsImportLibs(officialHashes)
    }
    const source = readFileSync(PIN_FILE, 'utf8')
    writeFileSync(
      PIN_FILE,
      replaceGeneratedBlock(source, renderGeneratedBlock(pin, assets, compatAssets))
    )
    console.log(`Wrote ${PIN_FILE}. Run check-node-runtime-pin.mjs before committing.`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
