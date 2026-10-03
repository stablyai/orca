import { join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { codexRolloutThreadMatch } from '../../shared/agent-transcript-layout'
import { readCodexRolloutSessionMetaId } from './codex-rollout-session-meta'
import { listCodexSessionJsonlFilesIncrementally } from './codex-session-file-listing'

export type CodexPinnedRolloutProofOptions = {
  listFiles?: (sessionsRoot: string) => AsyncIterable<string>
  readSessionMetaId?: (filePath: string) => Promise<string | null>
}

export async function resolvePinnedCodexRolloutProof(
  codexHome: string,
  threadId: string,
  options: CodexPinnedRolloutProofOptions = {}
): Promise<string | null> {
  const sessionsRoot = join(codexHome, 'sessions')
  const listFiles =
    options.listFiles ??
    ((root: string) => listCodexSessionJsonlFilesIncrementally(root, { batchSize: 64, yieldMs: 0 }))
  const readSessionMetaId = options.readSessionMetaId ?? readCodexRolloutSessionMetaId

  for await (const filePath of listFiles(sessionsRoot)) {
    const relativePath = relativePathInsideRoot(sessionsRoot, filePath)?.replace(/\\/g, '/')
    if (
      !relativePath ||
      !/^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(relativePath) ||
      codexRolloutThreadMatch(relativePath, threadId) === null
    ) {
      continue
    }
    if ((await readSessionMetaId(filePath)) === threadId) {
      return filePath
    }
  }
  return null
}
