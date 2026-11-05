import { join } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/antigravity-session-origin'

/** GEMINI_HOME of Orca's managed Antigravity chat, under the host's state directory. */
export const ANTIGRAVITY_CHAT_HOME_FOLDER = 'antigravity-chat'

/** The managed server's transcripts, outside the CLI's ~/.gemini tree that history scans by default. */
export function antigravityChatBrainDir(stateDirectory: string): string {
  return join(stateDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER, ANTIGRAVITY_ACP_HOME, 'brain')
}
