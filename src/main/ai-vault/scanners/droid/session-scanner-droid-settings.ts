import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { extractString } from '../../../../shared/text/trimmed-string'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
import { readJsonObjectIfExists } from '../../discovery/session-json-file'
import type { SidecarEnrichment } from '../../parse-cache/session-scanner-sidecar-enrichment'
import { asRecord } from '../../parsing/session-record-fields'
import { numberValue } from '../../parsing/session-scanner-token-values'

// Droid persists model and usage only in this sibling; the `system`/`completion` records that
// carry them exist on `droid exec --output-format stream-json` stdout, never in the transcript.
export async function enrichDroidSessionFromSettings(
  foldSession: AiVaultSession | null,
  transcriptPath: string,
  signal?: AbortSignal
): Promise<SidecarEnrichment> {
  if (!foldSession) {
    return { session: foldSession, refused: false }
  }
  // Droid discovery only yields `.jsonl` transcripts.
  const settingsPath = `${transcriptPath.slice(0, -'.jsonl'.length)}.settings.json`
  let record: Record<string, unknown> | null
  try {
    record = await readJsonObjectIfExists(settingsPath, signal)
  } catch (error) {
    if (!(error instanceof WslTranscriptFsError)) {
      throw error
    }
    return { session: foldSession, refused: true }
  }
  if (!record) {
    return { session: foldSession, refused: false }
  }
  return {
    session: {
      ...foldSession,
      model: extractString(record.model),
      totalTokens: droidOwnTokens(record.tokenUsage)
    },
    refused: false
  }
}

// `tokenUsage` is this session's own usage; `inclusiveTokenUsage` adds child sessions, which are
// listed as rows of their own. `thinkingTokens` is already counted in `outputTokens`.
function droidOwnTokens(value: unknown): number {
  const usage = asRecord(value)
  if (!usage) {
    return 0
  }
  return (
    numberValue(usage.inputTokens) +
    numberValue(usage.outputTokens) +
    numberValue(usage.cacheCreationTokens) +
    numberValue(usage.cacheReadTokens)
  )
}
