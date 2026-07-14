import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import {
  installNativeMessagingHost,
  type InstallBrowser,
  type InstallResult
} from '../../cli/chat-import-host/install-native-messaging-host'
import { resolveHostExecCommand } from '../../cli/chat-import-host/resolve-host-exec-command'
import { CHAT_IMPORT_EXTENSION_ID } from '../chat-import/chat-import-extension'
import { lastSyncedBySource } from '../chat-import/chat-import-last-synced'
import { chatImportDbPath } from '../chat-import/chat-import-paths'
import { detectBrowserSetup } from '../chat-import/native-host-setup-status'
import SyncDatabase from '../sqlite/sync-database'

export type ChatImportBrowserId = InstallBrowser

export type ChatImportBrowserStatus = {
  id: ChatImportBrowserId
  label: string
  detected: boolean
  hostInstalled: boolean
}

export type ChatImportLastSyncedBySource = Record<'CHATGPT' | 'CLAUDE' | 'GEMINI', string | null>

export type ChatImportSetupStatus = {
  browsers: ChatImportBrowserStatus[]
  lastSyncedBySource: ChatImportLastSyncedBySource
  extensionDir: string
}

export type ChatImportInstallResult = { ok: true } | { ok: false; error: string }

const BROWSERS: { id: InstallBrowser; label: string }[] = [
  { id: 'chrome', label: 'Chrome' },
  { id: 'edge', label: 'Edge' },
  { id: 'brave', label: 'Brave' },
  { id: 'chromium', label: 'Chromium' }
]

// Pure assembly — every filesystem/registry/db touch is injected so the
// settings pane's status view can be unit-tested without a real OS or Electron.
export function buildSetupStatus(deps: {
  platform: NodeJS.Platform
  homeDir: string
  userDataPath: string
  extensionDir: string
  exists: (p: string) => boolean
  registryHas: (registryKey: string) => boolean
  lastSynced: ChatImportLastSyncedBySource
}): ChatImportSetupStatus {
  return {
    browsers: BROWSERS.map((b) => ({
      ...b,
      ...detectBrowserSetup({
        browser: b.id,
        platform: deps.platform,
        homeDir: deps.homeDir,
        userDataPath: deps.userDataPath,
        exists: deps.exists,
        registryHas: deps.registryHas
      })
    })),
    lastSyncedBySource: deps.lastSynced,
    extensionDir: deps.extensionDir
  }
}

// Pure assembly — installs with the fixed extension ID (Task 1) so the
// settings pane never has to collect a manually-copied chrome://extensions ID.
export function resolveInstall(
  browser: InstallBrowser,
  deps: {
    platform: NodeJS.Platform
    homeDir: string
    userDataPath: string
    cliEntry: string
    execPath: string
    runRegistry: (registryKey: string, manifestPath: string) => void
    install: typeof installNativeMessagingHost
  }
): InstallResult {
  return deps.install({
    platform: deps.platform,
    homeDir: deps.homeDir,
    userDataPath: deps.userDataPath,
    browser,
    extensionId: CHAT_IMPORT_EXTENSION_ID,
    execCommand: resolveHostExecCommand(deps.execPath, deps.cliEntry),
    runRegistry: deps.runRegistry
  })
}

// Why: HKCU query mirrors runWindowsRegistryAdd below — same hive, no
// elevation needed. `/ve` reads the key's default value, which is all
// installNativeMessagingHost ever writes.
function registryHas(registryKey: string): boolean {
  try {
    execFileSync('reg.exe', ['query', `HKCU\\${registryKey}`, '/ve'], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

function runWindowsRegistryAdd(registryKey: string, manifestPath: string): void {
  execFileSync('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    windowsHide: true
  })
}

function resolveExtensionDir(): string {
  // Why: packaged extensions ship under resources/, dev serves them straight
  // from the repo — mirrors the resourcesPath split in agent-browser-bridge.ts.
  return app.isPackaged
    ? join(process.resourcesPath, 'extensions', 'chat-import')
    : join(app.getAppPath(), 'extensions', 'chat-import')
}

function readLastSynced(): ChatImportLastSyncedBySource {
  const dbPath = chatImportDbPath()
  if (!existsSync(dbPath)) {
    return { CHATGPT: null, CLAUDE: null, GEMINI: null }
  }
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  try {
    return lastSyncedBySource(db)
  } finally {
    db.close()
  }
}

async function getStatus(): Promise<ChatImportSetupStatus> {
  return buildSetupStatus({
    platform: process.platform,
    homeDir: homedir(),
    userDataPath: app.getPath('userData'),
    extensionDir: resolveExtensionDir(),
    exists: existsSync,
    registryHas,
    lastSynced: readLastSynced()
  })
}

async function install(browser: ChatImportBrowserId): Promise<ChatImportInstallResult> {
  if (!BROWSERS.some((b) => b.id === browser)) {
    return { ok: false, error: `Unknown browser: ${String(browser)}` }
  }
  try {
    resolveInstall(browser, {
      platform: process.platform,
      homeDir: homedir(),
      userDataPath: app.getPath('userData'),
      // Matches the CLI installer's launcher entry (src/main/cli/cli-installer.ts).
      cliEntry: join(app.getAppPath(), 'out', 'cli', 'index.js'),
      execPath: process.execPath,
      runRegistry: runWindowsRegistryAdd,
      install: installNativeMessagingHost
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerChatImportSetupHandlers(): void {
  ipcMain.handle('chatImportSetup:getStatus', () => getStatus())
  ipcMain.handle('chatImportSetup:install', (_event, browser: ChatImportBrowserId) =>
    install(browser)
  )
}
