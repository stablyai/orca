import { parse } from 'smol-toml'
import { join } from 'path'
import { keybindingCatalog } from '../../shared/keybindings/keybinding-catalog'
import { buildEffectiveKeymap } from '../../shared/keybindings/effective-keymap'
import type {
  EffectiveKeymap,
  KeybindingDiagnostic,
  KeybindingPlatform,
  UserKeybindingOverrideValue,
  UserKeybindingOverrides
} from '../../shared/keybindings/keybinding-types'

const PLATFORM_TABLES = new Set(['macos', 'linux', 'windows'])

export function userKeybindingConfigPath(homeDirectory: string): string {
  return join(homeDirectory, '.orca', 'keybindings.toml')
}

export function displayUserKeybindingConfigPath(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? '%USERPROFILE%\\.orca\\keybindings.toml'
    : '~/.orca/keybindings.toml'
}

export function nodePlatformToKeybindingPlatform(platform: NodeJS.Platform): KeybindingPlatform {
  if (platform === 'darwin') {
    return 'macos'
  }
  if (platform === 'win32') {
    return 'windows'
  }
  return 'linux'
}

export type ParsedUserKeybindingConfig = {
  overrides: UserKeybindingOverrides
  diagnostics: KeybindingDiagnostic[]
}

export type UserKeybindingConfigReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'missing' | 'unreadable'; message?: string }

export type LoadedUserKeybindingConfig = {
  configPath: string
  keymap: EffectiveKeymap
  fileState: 'missing' | 'loaded' | 'unreadable' | 'malformed'
}

export function loadUserKeybindingConfig({
  configPath,
  platform,
  readTextFile
}: {
  configPath: string
  platform: KeybindingPlatform
  readTextFile: (configPath: string) => UserKeybindingConfigReadResult
}): LoadedUserKeybindingConfig {
  const file = readTextFile(configPath)
  if (!file.ok) {
    return {
      configPath,
      fileState: file.reason,
      keymap: buildEffectiveKeymap({ catalog: keybindingCatalog, platform })
    }
  }

  const parsed = parseUserKeybindingConfigToml(file.text, platform)
  const keymap = buildEffectiveKeymap({
    catalog: keybindingCatalog,
    platform,
    overrides: parsed.overrides
  })

  return {
    configPath,
    fileState: parsed.diagnostics.some((diagnostic) => diagnostic.message.includes('TOML'))
      ? 'malformed'
      : 'loaded',
    keymap: {
      ...keymap,
      diagnostics: [...parsed.diagnostics, ...keymap.diagnostics]
    }
  }
}

export function parseUserKeybindingConfigToml(
  source: string,
  platform: KeybindingPlatform
): ParsedUserKeybindingConfig {
  const diagnostics: KeybindingDiagnostic[] = []
  let document: unknown

  try {
    document = parse(source)
  } catch (error) {
    return {
      overrides: {},
      diagnostics: [
        {
          code: 'invalid-value',
          message: `Invalid keybindings TOML: ${error instanceof Error ? error.message : 'unknown parse error'}`
        }
      ]
    }
  }

  const root = asRecord(document)
  const keybindings = root ? asRecord(root.keybindings) : null
  if (!keybindings) {
    if (root && 'keybindings' in root) {
      diagnostics.push({
        code: 'invalid-value',
        message: '[keybindings] must be a table'
      })
    }
    return { overrides: {}, diagnostics }
  }

  const overrides: UserKeybindingOverrides = {}
  copyOverrideTable({ table: keybindings, overrides, diagnostics, skipPlatformTables: true })

  const platformTable = asRecord(keybindings[platform])
  if (platformTable) {
    copyOverrideTable({ table: platformTable, overrides, diagnostics, skipPlatformTables: false })
  } else if (keybindings[platform] !== undefined) {
    diagnostics.push({
      code: 'invalid-value',
      message: `[keybindings.${platform}] must be a table`
    })
  }

  return { overrides, diagnostics }
}

function copyOverrideTable({
  table,
  overrides,
  diagnostics,
  skipPlatformTables
}: {
  table: Record<string, unknown>
  overrides: UserKeybindingOverrides
  diagnostics: KeybindingDiagnostic[]
  skipPlatformTables: boolean
}): void {
  for (const [actionId, value] of Object.entries(table)) {
    if (skipPlatformTables && PLATFORM_TABLES.has(actionId)) {
      continue
    }
    const override = toOverrideValue(value)
    if (override === null) {
      diagnostics.push({
        code: 'invalid-value',
        actionId,
        message: `Invalid keybinding value for ${actionId}`
      })
      continue
    }
    overrides[actionId] = override
  }
}

function toOverrideValue(value: unknown): UserKeybindingOverrideValue | null {
  if (typeof value === 'string') {
    return value.toLowerCase() === 'none' ? 'none' : value
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}
