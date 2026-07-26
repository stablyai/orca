import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta } from './history-manager'
import { getHistorySessionDirName } from './history-paths'
import { readTerminalHistoryJson } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_META_MAX_BYTES } from './terminal-history-file-limits'

export type TerminalHistoryMetadataProbe =
  | { kind: 'meta-absent' | 'meta-corrupt' }
  | { kind: 'valid'; meta: SessionMeta }

export function probeTerminalHistoryMetadata(
  basePath: string,
  sessionId: string
): TerminalHistoryMetadataProbe {
  const metaPath = join(basePath, getHistorySessionDirName(sessionId), 'meta.json')
  if (!existsSync(metaPath)) {
    return { kind: 'meta-absent' }
  }
  try {
    return {
      kind: 'valid',
      meta: readTerminalHistoryJson<SessionMeta>(metaPath, TERMINAL_HISTORY_META_MAX_BYTES)
    }
  } catch {
    return { kind: 'meta-corrupt' }
  }
}
