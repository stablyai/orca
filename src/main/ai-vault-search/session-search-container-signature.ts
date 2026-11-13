import { throwIfAiVaultScanCancelled } from '../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import { isMissingTranscriptPathError } from '../ai-vault/discovery/session-scanner-discovery'
import { wslGatedStat } from '../native-chat/transcript-filesystem/wsl-transcript-fs-access'

export async function sessionSearchContainerSignature(path: string, signal?: AbortSignal) {
  let known = true
  let identity = ''
  const facts = await Promise.all(
    [path, `${path}-wal`].map(async (input) => {
      try {
        const stat = await wslGatedStat(input, 'scan', signal)
        const id = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
        if (input === path) {
          identity = id
        }
        return `${id}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      } catch (error) {
        throwIfAiVaultScanCancelled(signal)
        if (isMissingTranscriptPathError(error)) {
          return 'missing'
        }
        known = false
        return 'unknown'
      }
    })
  )
  return { known, identity, signature: facts.join('|') }
}
