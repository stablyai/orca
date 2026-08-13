// Why: Gemini CLI was removed, but managed hook entries remain in
// ~/.gemini/settings.json and ~/.orca/agent-hooks/gemini-hook.* and still POST
// to /hook/gemini (404). Antigravity intentionally lives under ~/.gemini too —
// only strip commands that match the managed gemini-hook script name.

import { unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  readHooksJson,
  removeManagedCommands,
  writeHooksJson,
  type HooksConfig
} from './installer-utils'
import { readHooksJsonRemote, writeHooksJsonRemote } from './installer-utils-remote'

// Why: installs emitted .sh (POSIX) or .cmd/.ps1 (Windows); sweep every variant.
const SCRIPT_FILES = ['gemini-hook.sh', 'gemini-hook.cmd', 'gemini-hook.ps1'] as const
const isManagedCommand = createManagedCommandMatcher('gemini-hook.sh')

/** Returns the rewritten config, or null when the file holds no managed Gemini hooks. */
function stripManagedGeminiHooks(config: HooksConfig): HooksConfig | null {
  const hooks = config.hooks
  if (!hooks || typeof hooks !== 'object') {
    return null
  }
  const nextHooks = { ...hooks }
  let changed = false
  for (const [eventName, definitions] of Object.entries(hooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === definitions.length) {
      continue
    }
    changed = true
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  return changed ? { ...config, hooks: nextHooks } : null
}

/**
 * Why gate the unlink: a config Orca could not parse (JSONC comments) or could
 * not rewrite may still hold a live entry pointing at the script. Deleting it
 * then turns a 404 POST into empty stdout, which a JSON-expecting Gemini CLI
 * reads as a broken hook — worse than the stale endpoint. Only sweep the
 * scripts once the settings file is known to be free of managed entries.
 */
export function removeRetiredGeminiManagedHooksLocal(): void {
  const configPath = join(homedir(), '.gemini', 'settings.json')
  const config = readHooksJson(configPath)
  if (!config) {
    return
  }
  const cleaned = stripManagedGeminiHooks(config)
  if (cleaned) {
    try {
      writeHooksJson(configPath, cleaned)
    } catch {
      return
    }
  }
  for (const fileName of SCRIPT_FILES) {
    try {
      unlinkSync(getSharedManagedScriptPath(fileName))
    } catch {
      // Missing file or permission error; settings cleanup already stops the POSTs.
    }
  }
}

/** Idempotent remote (SSH/WSL) cleanup mirroring local remove for Gemini CLI hooks. */
export async function removeRetiredGeminiManagedHooksRemote(
  sftp: SFTPWrapper,
  remoteHome: string
): Promise<void> {
  const home = remoteHome.replace(/\/$/, '')
  const configPath = `${home}/.gemini/settings.json`
  try {
    const config = await readHooksJsonRemote(sftp, configPath)
    if (!config) {
      return
    }
    const cleaned = stripManagedGeminiHooks(config)
    if (cleaned) {
      await writeHooksJsonRemote(sftp, configPath, cleaned)
    }
  } catch {
    // Best-effort: do not block remote hook install for other agents. Leave the
    // scripts in place so any surviving entry still resolves (see local note).
    return
  }
  for (const fileName of SCRIPT_FILES) {
    // Missing file or permission errors are non-fatal for upgrade cleanup.
    await new Promise<void>((resolve) => {
      sftp.unlink(`${home}/.orca/agent-hooks/${fileName}`, () => resolve())
    })
  }
}
