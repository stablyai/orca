import { wslGatedReadFile } from '../../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../native-chat/wsl-transcript-fs-error'
import { asRecord } from '../parsing/session-record-fields'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'

export async function readJsonObjectIfExists(
  filePath: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await wslGatedReadFile(filePath, 'utf-8', 'scan', signal))
    return asRecord(parsed)
  } catch (error) {
    // Propagate cancellation so it cannot be cached as absent enrichment.
    throwIfAiVaultScanCancelled(signal)
    // Propagate WSL refusal as an issue; caching null can prevent retries for unchanged files.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return null
  }
}
