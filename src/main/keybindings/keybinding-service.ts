import type { KeybindingSnapshot } from '../../shared/keybindings/keybinding-types'
import { dirname } from 'path'
import { keybindingCatalog } from '../../shared/keybindings/keybinding-catalog'
import type {
  KeybindingCatalogEntry,
  KeybindingPlatform
} from '../../shared/keybindings/keybinding-types'
import {
  displayUserKeybindingConfigPath,
  loadUserKeybindingConfig,
  nodePlatformToKeybindingPlatform,
  userKeybindingConfigPath,
  type UserKeybindingConfigReadResult
} from './user-keybinding-config'

const STARTER_CONFIG_PLATFORMS: KeybindingPlatform[] = ['linux', 'macos', 'windows']

function renderStarterKeybindingConfig(catalog: KeybindingCatalogEntry[]): string {
  const platformSections = STARTER_CONFIG_PLATFORMS.map((platform) =>
    [
      `[keybindings.${platform}]`,
      ...catalog.flatMap((entry) => [
        `# ${entry.title}`,
        `# ${quoteTomlString(entry.id)} = ${formatDefaultOverrideValue(entry.defaults[platform])}`,
        ''
      ])
    ].join('\n')
  )

  return `# Orca keybindings
# Edit this file, then use Settings > Shortcuts > Reload Keybindings.
# Uncomment an action to override it. Overrides replace the full chord set.
# Use "none" to unbind an action.

${platformSections.join('\n')}`
}

function formatDefaultOverrideValue(defaults: string[] | undefined): string {
  if (!defaults || defaults.length === 0) {
    return quoteTomlString('none')
  }
  if (defaults.length === 1) {
    return quoteTomlString(defaults[0])
  }
  return `[${defaults.map(quoteTomlString).join(', ')}]`
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value)
}

export type UserKeybindingService = {
  getSnapshot: () => KeybindingSnapshot
  reload: () => KeybindingSnapshot
  openConfig: () => Promise<void> | void
  revealConfig: () => Promise<void> | void
}

export function createUserKeybindingService({
  homeDirectory,
  platform,
  readTextFile,
  now = Date.now,
  openConfig,
  revealConfig
}: {
  homeDirectory: string
  platform: NodeJS.Platform
  readTextFile: (configPath: string) => UserKeybindingConfigReadResult
  now?: () => number
  openConfig: () => Promise<void> | void
  revealConfig: () => Promise<void> | void
}): UserKeybindingService {
  const configPath = userKeybindingConfigPath(homeDirectory)
  const displayPath = displayUserKeybindingConfigPath(platform)
  const keybindingPlatform = nodePlatformToKeybindingPlatform(platform)

  const readSnapshot = (): KeybindingSnapshot => {
    const loaded = loadUserKeybindingConfig({
      configPath,
      platform: keybindingPlatform,
      readTextFile
    })
    return {
      configPath,
      displayPath,
      fileState: loaded.fileState,
      keymap: loaded.keymap,
      loadedAt: now()
    }
  }

  let snapshot = readSnapshot()

  return {
    getSnapshot: () => snapshot,
    reload: () => {
      snapshot = readSnapshot()
      return snapshot
    },
    openConfig,
    revealConfig
  }
}

export function createUserKeybindingServiceFromDisk({
  homeDirectory,
  platform,
  now,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openPath,
  showItemInFolder
}: {
  homeDirectory: string
  platform: NodeJS.Platform
  now?: () => number
  existsSync: (path: string) => boolean
  mkdirSync: (path: string, options: { recursive: true }) => unknown
  readFileSync: (path: string, encoding: 'utf8') => string
  writeFileSync: (path: string, text: string, encoding: 'utf8') => unknown
  openPath: (path: string) => Promise<unknown> | unknown
  showItemInFolder: (path: string) => void
}): UserKeybindingService {
  const configPath = userKeybindingConfigPath(homeDirectory)

  const ensureStarterConfig = (): void => {
    if (existsSync(configPath)) {
      return
    }
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, renderStarterKeybindingConfig(keybindingCatalog), 'utf8')
  }

  return createUserKeybindingService({
    homeDirectory,
    platform,
    now,
    readTextFile: (path) => {
      if (!existsSync(path)) {
        return { ok: false, reason: 'missing' }
      }
      try {
        return { ok: true, text: readFileSync(path, 'utf8') }
      } catch (error) {
        return {
          ok: false,
          reason: 'unreadable',
          message: error instanceof Error ? error.message : 'Unable to read keybindings config'
        }
      }
    },
    openConfig: async () => {
      ensureStarterConfig()
      await openPath(configPath)
    },
    revealConfig: () => {
      ensureStarterConfig()
      showItemInFolder(configPath)
    }
  })
}
