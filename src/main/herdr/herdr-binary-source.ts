import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/types'
import { normalizeHerdrBinarySource, type HerdrBinarySource } from '../../shared/terminal-backend'
import { HerdrRuntimeError } from './herdr-runtime-contract'

type HerdrSettings = Pick<GlobalSettings, 'herdrBinarySource' | 'hostSettingOverrides'>

export function resolveHerdrBinarySource(
  settings: HerdrSettings,
  hostId: ExecutionHostId
): HerdrBinarySource {
  return normalizeHerdrBinarySource(
    settings.hostSettingOverrides?.[hostId]?.herdrBinarySource ?? settings.herdrBinarySource
  )
}

export function resolveLocalHerdrExecutable(args: {
  source: HerdrBinarySource
  isPackaged: boolean
  resourcesPath: string
  platform: NodeJS.Platform
  arch: string
  developmentOverride?: string
}): string {
  if (args.source.kind === 'custom') {
    const path = args.source.path.trim()
    if (!path) {
      throw new HerdrRuntimeError('herdr_unavailable', 'Custom Herdr path is empty')
    }
    return path
  }
  const executable = args.platform === 'win32' ? 'herdr.exe' : 'herdr'
  if (args.source.kind === 'system') {
    return executable
  }
  if (!args.isPackaged) {
    return args.developmentOverride?.trim() || executable
  }
  return join(args.resourcesPath, 'herdr', `${args.platform}-${args.arch}`, executable)
}

type ManagedHerdrManifest = {
  version: string
  sourceCommit: string
  sourceUrl: string
  protocol: number
  sha256: string
  capabilities: Record<string, boolean>
}

const REQUIRED_MANAGED_CAPABILITIES = [
  'external_refs',
  'resumable_events',
  'portable_layouts',
  'terminal_control_v2',
  'terminal_history',
  'controller_takeover'
] as const

export function verifyManagedHerdrExecutable(
  executable: string,
  platform: NodeJS.Platform = process.platform
): ManagedHerdrManifest {
  try {
    accessSync(executable, platform === 'win32' ? constants.F_OK : constants.X_OK)
    const directory = dirname(executable)
    const manifest = JSON.parse(
      readFileSync(join(directory, 'manifest.json'), 'utf8')
    ) as ManagedHerdrManifest
    accessSync(join(directory, 'LICENSE'), constants.R_OK)
    if (
      !manifest.version?.trim() ||
      !manifest.sourceCommit?.trim() ||
      !manifest.sourceUrl?.trim() ||
      manifest.protocol < 17
    ) {
      throw new Error('manifest identity or protocol is invalid')
    }
    const missing = REQUIRED_MANAGED_CAPABILITIES.filter(
      (capability) => manifest.capabilities?.[capability] !== true
    )
    if (missing.length > 0) {
      throw new Error(`missing capabilities: ${missing.join(', ')}`)
    }
    const actualSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
    if (actualSha256 !== manifest.sha256.toLowerCase()) {
      throw new Error('SHA-256 checksum mismatch')
    }
    return manifest
  } catch (error) {
    throw new HerdrRuntimeError(
      'herdr_unavailable',
      `Managed Herdr distribution is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
