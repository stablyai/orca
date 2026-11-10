import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { isMissingTranscriptPathError } from './session-file-observation'
import { readSessionIndexJsonl, type SessionIndexJsonlRead } from './session-index-jsonl-read'

/** Each owner keeps its own accepted cursor, independent of foreground History cache reads. */
export function createSessionJsonlDependency(
  path: string,
  parse: (line: string) => readonly [string, string] | null
): (force: boolean) => Promise<ReadonlySet<string>> {
  let accepted: SessionIndexJsonlRead | undefined
  let signature: string | undefined
  return async (force) => {
    let stat
    try {
      stat = await wslGatedStat(path, 'scan')
    } catch (error) {
      if (!isMissingTranscriptPathError(error)) {
        throw error
      }
      const removed = new Set(accepted?.values.keys())
      accepted = undefined
      signature = undefined
      return removed
    }
    const nextSignature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    if (!force && signature === nextSignature) {
      return new Set()
    }
    // Commit the cursor only after a complete successful read; refusal leaves the input owed.
    const next = await readSessionIndexJsonl(path, stat, accepted, parse)
    accepted = next
    signature = nextSignature
    return next.changedKeys
  }
}
