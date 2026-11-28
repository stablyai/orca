import { realpath } from 'node:fs/promises'
import type { AcpInstructionsDelivery } from './acp-instructions'
import {
  acquireFolderContextSlotChain,
  removeFolderContextFile,
  writeFolderContextFile
} from './acp-folder-context-file'

// Vibe builds its system prompt from AGENTS.md files at session open (walk-up from the cwd plus
// $VIBE_HOME/AGENTS.md) and keeps it with the session; new_session discards extra kwargs, so
// sessionMeta cannot carry the text. Every open takes the slot chain for AGENTS.md — in the cwd
// and every ancestor, even with no text — and holds it until the open returns, so two chats whose
// folders nest cannot read each other's instructions. An open with no text first clears a block an
// earlier open's failed cleanup left behind, and no open proceeds while one remains: Vibe reads
// AGENTS.md now, so it would become this chat's instructions.
export const deliverVibeInstructions: AcpInstructionsDelivery = {
  eachStart: false,
  runsWithoutText: true,
  launch: async ({ text }) => ({
    aroundSessionOpen: async (cwd, signal) => {
      // One resolution for the whole open, so the slot keys and the write target cannot diverge.
      const realCwd = await realpath(cwd).catch(() => cwd)
      const release = await acquireFolderContextSlotChain(realCwd, 'AGENTS.md', signal)
      try {
        if (text) {
          await writeFolderContextFile(realCwd, 'AGENTS.md', 'Mistral Vibe', text)
        }
        if (!text && !(await removeFolderContextFile(realCwd, 'AGENTS.md', 'Mistral Vibe'))) {
          throw new Error('a stale Mistral Vibe block in AGENTS.md could not be removed')
        }
      } catch (error) {
        release()
        throw error
      }
      return async () => {
        try {
          if (text && !(await removeFolderContextFile(realCwd, 'AGENTS.md', 'Mistral Vibe'))) {
            throw new Error('the Mistral Vibe block in AGENTS.md could not be removed')
          }
        } finally {
          release()
        }
      }
    }
  })
}
