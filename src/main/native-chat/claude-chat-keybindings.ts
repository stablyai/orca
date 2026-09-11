import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from '../claude-accounts/claude-profile-paths'

/** The user's Claude Code keybindings.json, so the renderer can submit with the gesture bound to
 *  `chat:submit` instead of a bare Enter remapped to insert a newline. Null when absent or
 *  unreadable; the renderer then submits with Enter. */
export async function readClaudeChatKeybindings(): Promise<string | null> {
  const claudeHome = resolveClaudeDefaultHome(homedir(), readUserClaudeConfigDir(process.env))
  try {
    return await readFile(join(claudeHome, 'keybindings.json'), 'utf8')
  } catch {
    return null
  }
}
