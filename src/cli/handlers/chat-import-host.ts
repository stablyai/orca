import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { chatImportDbPath } from '../../main/chat-import/chat-import-paths'
import { runChatImportHost } from '../chat-import-host/run-chat-import-host'
import {
  installNativeMessagingHost,
  type InstallBrowser,
  type InstallResult
} from '../chat-import-host/install-native-messaging-host'
import { resolveHostExecCommand } from '../chat-import-host/resolve-host-exec-command'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getDefaultUserDataPath, RuntimeClientError } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'

const INSTALL_BROWSERS: readonly InstallBrowser[] = ['chrome', 'edge', 'brave', 'chromium']

// Why: HKCU is per-user and needs no elevation; mirrors the reg.exe query
// pattern in windows-environment-path.ts but for a registry write.
function runWindowsRegistryAdd(registryKey: string, manifestPath: string): void {
  execFileSync('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    windowsHide: true
  })
}

function getInstallBrowser(flags: Map<string, string | boolean>): InstallBrowser {
  const raw = flags.get('browser')
  if (raw === undefined) {
    return 'chrome'
  }
  if (typeof raw !== 'string' || !INSTALL_BROWSERS.includes(raw as InstallBrowser)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--browser must be one of: ${INSTALL_BROWSERS.join(', ')}`
    )
  }
  return raw as InstallBrowser
}

function getExtensionId(flags: Map<string, string | boolean>): string {
  const raw = flags.get('extension-id')
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing required --extension-id. Open chrome://extensions, copy the loaded extension ID, then pass it with --extension-id.'
    )
  }
  return raw
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: { runtimeId: 'local' }
  }
}

function formatInstallResult(browser: InstallBrowser, result: InstallResult): string {
  return [
    `Installed the chat-import native-messaging host for ${browser}.`,
    `  launcher: ${result.launcherPath}`,
    `  manifest: ${result.manifestPath}`,
    'Reload the extension (chrome://extensions -> Reload) to pick up the new host.'
  ].join('\n')
}

export const CHAT_IMPORT_HOST_HANDLERS: Record<string, CommandHandler> = {
  // Why: stdout is the native-messaging channel to the browser, so this
  // handler must never share it with ordinary CLI logging/JSON output.
  'chat-import-host': async () => {
    await runChatImportHost({
      input: process.stdin,
      output: process.stdout,
      dbPath: chatImportDbPath()
    })
  },
  // Why: unlike the host handler above, this is a regular CLI command run
  // interactively by the user (or the extension's setup flow), so ordinary
  // stdout logging/JSON output is fine here.
  'chat-import-host install': async ({ flags, json }) => {
    const extensionId = getExtensionId(flags)
    const browser = getInstallBrowser(flags)
    const result = installNativeMessagingHost({
      platform: process.platform,
      homeDir: homedir(),
      userDataPath: getDefaultUserDataPath(),
      browser,
      extensionId,
      execCommand: resolveHostExecCommand(process.execPath, process.argv[1] ?? ''),
      runRegistry: runWindowsRegistryAdd
    })
    printResult(localSuccess(result), json, (r) => formatInstallResult(browser, r))
  }
}
