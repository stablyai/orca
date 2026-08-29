import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME } from '../../src/shared/relay-artifacts.ts'
import {
  windowsProcessTreeRelaySha256,
  WINDOWS_PROCESS_TREE_RELAY_ARCHES,
  WINDOWS_PROCESS_TREE_RELAY_CONTRACT_VERSION,
  WINDOWS_PROCESS_TREE_RELAY_PACKAGE
} from '../../src/shared/windows-process-tree-relay-manifest.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
export const WINDOWS_PROCESS_TREE_RELAY_ASSET_DIR = join(
  ROOT,
  'config',
  'relay-assets',
  'windows-process-tree'
)
const MANIFEST_PATH = join(WINDOWS_PROCESS_TREE_RELAY_ASSET_DIR, 'manifest.json')

const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 }

function assertSupportedArch(arch) {
  if (!WINDOWS_PROCESS_TREE_RELAY_ARCHES.includes(arch)) {
    throw new Error(
      `Windows process-tree relay architecture must be ${WINDOWS_PROCESS_TREE_RELAY_ARCHES.join(' or ')}; got ${arch}.`
    )
  }
}

export function windowsProcessTreeRelayAssetPath(arch) {
  assertSupportedArch(arch)
  return join(WINDOWS_PROCESS_TREE_RELAY_ASSET_DIR, arch, RELAY_WINDOWS_PROCESS_TREE_FILENAME)
}

export function readWindowsProcessTreePeMachine(bytes, label = 'Windows process-tree binary') {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${label} has no valid DOS header.`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset > bytes.length - 6 || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${label} has no valid PE header.`)
  }
  return bytes.readUInt16LE(peOffset + 4)
}

export function assertWindowsProcessTreePeMachine(bytes, arch, label) {
  assertSupportedArch(arch)
  const machine = readWindowsProcessTreePeMachine(bytes, label)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(
      `${label} is machine 0x${machine.toString(16)}, expected 0x${PE_MACHINE[arch].toString(16)} for ${arch}.`
    )
  }
  return machine
}

export function validateWindowsProcessTreeRelayAsset(arch) {
  validateManifestMetadata()
  const binaryPath = windowsProcessTreeRelayAssetPath(arch)
  const bytes = readFileSync(binaryPath)
  assertWindowsProcessTreePeMachine(bytes, arch, binaryPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const expectedSha256 = windowsProcessTreeRelaySha256(arch)
  if (sha256 !== expectedSha256) {
    throw new Error(
      `${binaryPath} has SHA-256 ${sha256}, but manifest.json requires ${expectedSha256}.`
    )
  }
  return { binaryPath, bytes, sha256 }
}

function validateManifestMetadata() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  if (manifest.contractVersion !== WINDOWS_PROCESS_TREE_RELAY_CONTRACT_VERSION) {
    throw new Error(
      `${MANIFEST_PATH} contractVersion must be ${WINDOWS_PROCESS_TREE_RELAY_CONTRACT_VERSION}.`
    )
  }
  if (manifest.package !== WINDOWS_PROCESS_TREE_RELAY_PACKAGE) {
    throw new Error(`${MANIFEST_PATH} package must be ${WINDOWS_PROCESS_TREE_RELAY_PACKAGE}.`)
  }
  for (const arch of WINDOWS_PROCESS_TREE_RELAY_ARCHES) {
    const expectedSha256 = windowsProcessTreeRelaySha256(arch)
    if (manifest.binaries?.[arch]?.sha256 !== expectedSha256) {
      throw new Error(`${MANIFEST_PATH} ${arch} SHA-256 must be ${expectedSha256}.`)
    }
  }
}
