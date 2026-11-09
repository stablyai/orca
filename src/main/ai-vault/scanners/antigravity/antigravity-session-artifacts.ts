import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import type { SessionFileDiscovery } from '../../session-scanner-types'
import { antigravityConversationIdFromTranscriptPath } from './session-scanner-antigravity-paths'

/** Discovery already lists each `<brain>/<id>/`; remember one top-level artifact file there. */
export function recordAntigravityArtifactPath(
  artifactPaths: Map<string, string>,
  brainDir: string,
  dirPath: string,
  entries: readonly Dirent[]
): void {
  if (dirPath !== join(brainDir, basename(dirPath))) {
    return
  }
  // Names only: agy's own state (.system_generated, scratch, .user_uploaded) lives in subdirectories.
  let first: string | null = null
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith('.') && (first === null || entry.name < first)) {
      first = entry.name
    }
  }
  artifactPaths.delete(dirPath)
  if (first !== null) {
    artifactPaths.set(dirPath, join(dirPath, first))
  }
}

export function withAntigravityArtifactPaths(
  sessions: AiVaultSession[],
  discoveries: readonly SessionFileDiscovery[]
): AiVaultSession[] {
  const artifactPaths = discoveries.flatMap((discovery) =>
    discovery.antigravityArtifactPaths?.size ? [discovery.antigravityArtifactPaths] : []
  )
  if (artifactPaths.length === 0) {
    return sessions
  }
  return sessions.map((session) => {
    if (
      session.agent !== 'antigravity' ||
      !antigravityConversationIdFromTranscriptPath(session.filePath)
    ) {
      return session
    }
    const conversationDir = dirname(dirname(dirname(session.filePath)))
    const artifactPath = artifactPaths
      .map((paths) => paths.get(conversationDir))
      .find((path) => path !== undefined)
    return artifactPath ? { ...session, antigravityArtifactPath: artifactPath } : session
  })
}
