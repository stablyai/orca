import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const { PE_MACHINE, readPeMachine } = createRequire(import.meta.url)('./windows-pe-machine.cjs')
export const WINDOWS_WATCHER_VERSION = '2.5.6'
export const WINDOWS_WATCHER_PATCH = join(
  root,
  'config/patches/parcel-watcher-windows-readiness.patch'
)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function readWindowsWatcherArtifact(arch, directory = join(root, '.build/windows-watcher')) {
  if (!Object.hasOwn(PE_MACHINE, arch)) {
    throw new Error(`Unsupported Windows watcher architecture: ${arch}`)
  }
  const artifact = join(directory, arch)
  const binary = join(artifact, 'watcher.node')
  const license = join(artifact, 'LICENSE')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8'))
  } catch (cause) {
    throw new Error(
      `Missing or invalid Windows watcher build receipt for ${arch} at ${artifact}. See config/patches/parcel-watcher-windows-readiness.md`,
      { cause }
    )
  }
  if (
    manifest?.version !== WINDOWS_WATCHER_VERSION ||
    manifest.arch !== arch ||
    manifest.sanitized !== false ||
    manifest.patchSha256 !== sha256(readFileSync(WINDOWS_WATCHER_PATCH))
  ) {
    throw new Error(`Windows watcher receipt does not match the shipping source for ${arch}`)
  }
  if (
    sha256(readFileSync(binary)) !== manifest.sha256 ||
    readPeMachine(binary) !== PE_MACHINE[arch]
  ) {
    throw new Error(`Windows watcher binary does not match its receipt or architecture for ${arch}`)
  }
  if (!readFileSync(license, 'utf8').includes('Permission is hereby granted')) {
    throw new Error(`Windows watcher license is missing or invalid for ${arch}`)
  }
  return { binary, license }
}
