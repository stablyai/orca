import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ANTIGRAVITY_BRAIN_HOME_SEGMENTS,
  antigravityTranscriptSegmentsInBrain
} from '../ai-vault/session-scanner-antigravity-paths'
import {
  createWslTranscriptResolutionSnapshot,
  toHostReadableTranscriptPath,
  wslAntigravityTranscriptPaths
} from './host-readable-transcript-path'
import { wslTranscriptFsRefusal, type WslTranscriptFsError } from './wsl-transcript-fs-gate'

export async function resolveAntigravitySessionFile(
  conversationId: string,
  brainDirOverride: string | undefined,
  signal?: AbortSignal,
  wslDistro?: string
): Promise<string | null> {
  // A conversation id is one directory segment, never a caller-supplied path.
  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
    return null
  }
  const hostHit = wslDistro
    ? null
    : await toHostReadableTranscriptPath(
        join(
          brainDirOverride ?? join(homedir(), ...ANTIGRAVITY_BRAIN_HOME_SEGMENTS),
          ...antigravityTranscriptSegmentsInBrain(conversationId)
        ),
        { signal }
      )
  signal?.throwIfAborted()
  if (!wslDistro) {
    return hostHit
  }
  if (process.platform !== 'win32') {
    return null
  }
  // Only inspect the attested guest; equal session ids do not establish ownership.
  signal?.throwIfAborted()
  const wslSnapshot = await createWslTranscriptResolutionSnapshot({ includeHomes: false })
  wslSnapshot.runningDistros = wslSnapshot.runningDistros.filter((distro) => distro === wslDistro)
  signal?.throwIfAborted()
  let unavailable: WslTranscriptFsError | undefined
  for (const candidate of await wslAntigravityTranscriptPaths(conversationId, { wslSnapshot })) {
    try {
      const hit = await toHostReadableTranscriptPath(candidate, { signal, wslSnapshot, wslDistro })
      if (hit) {
        return hit
      }
    } catch (error) {
      signal?.throwIfAborted()
      unavailable = wslTranscriptFsRefusal(error)
    }
  }
  if (unavailable) {
    throw unavailable
  }
  return null
}
