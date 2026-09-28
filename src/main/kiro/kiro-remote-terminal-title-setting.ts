import type { IFilesystemProvider } from '../providers/types'
import {
  KIRO_TERMINAL_TITLE_SETTING,
  type KiroTerminalTitleResult
} from './kiro-terminal-title-setting'

/**
 * The SSH-host copy of the local preflight: Kiro runs on the execution host, so
 * its `chat.terminalTitle` has to be on there, not on the client's machine.
 *
 * Why a file write rather than the `kiro-cli settings` call the local path uses:
 * the filesystem provider is the only contract Orca has for remote vendor
 * settings — the same one the remote Codex and Copilot trust writes use — and
 * running a CLI on the host would need a pty lane the launch does not own yet.
 * Still one key, still only when unset, so a user's explicit `false` stands.
 */
export async function enableRemoteKiroTerminalTitle(
  fsProvider: IFilesystemProvider,
  remoteHome: string
): Promise<KiroTerminalTitleResult> {
  const settingsDir = `${remoteHome}/.kiro/settings`
  const settingsPath = `${settingsDir}/cli.json`
  let settings: Record<string, unknown> = {}
  const raw = await readRemoteSettingsText(fsProvider, settingsPath)
  if (raw === null) {
    return 'failed'
  }
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        // An unreadable shape is the user's file, not ours to replace.
        return 'failed'
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the three checks above rule out every non-record JSON value.
      settings = parsed as Record<string, unknown>
    } catch {
      return 'failed'
    }
  }
  if (KIRO_TERMINAL_TITLE_SETTING in settings) {
    return 'already-set'
  }
  try {
    await fsProvider.createDir(settingsDir)
    await fsProvider.writeFile(
      settingsPath,
      `${JSON.stringify({ ...settings, [KIRO_TERMINAL_TITLE_SETTING]: true }, null, 2)}\n`
    )
    return 'enabled'
  } catch {
    return 'failed'
  }
}

/** Empty string for "no file yet", null for "the host has one but would not hand it over". */
async function readRemoteSettingsText(
  fsProvider: IFilesystemProvider,
  settingsPath: string
): Promise<string | null> {
  try {
    await fsProvider.stat(settingsPath)
  } catch {
    return ''
  }
  try {
    const result = await fsProvider.readFile(settingsPath)
    return result.isBinary ? null : result.content
  } catch {
    return null
  }
}
