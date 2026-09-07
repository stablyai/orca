import { ipcMain } from 'electron'
import { searchAiVaultTranscripts } from '../ai-vault/session-transcript-search'
import type { AiVaultTranscriptSearchArgs } from '../../shared/ai-vault-transcript-search'

// Deep search reads local transcript files only; the renderer narrows its
// requests to local sessions. Like the other read-only vault handlers, the
// main process trusts the renderer's paths — normalization bounds the payload
// size and request count, it does not enforce path containment.
export function registerAiVaultTranscriptSearchHandler(): void {
  ipcMain.handle('aiVault:searchTranscripts', (_event, args?: AiVaultTranscriptSearchArgs) =>
    searchAiVaultTranscripts(args ?? { query: '', requests: [] })
  )
}
