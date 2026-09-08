import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type {
  SessionSearchIndexResult,
  SessionSearchIndexUpdate
} from '../ai-vault/session-search-capture'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type SyncDatabase from '../sqlite/sync-database'
import { openSessionSearchDatabase } from './session-search-schema'

/** Carries `session`/`byteOffset` alongside the write so assertions can read the expected result. */
export function stagedWriteUpdate(
  text: string,
  count: number,
  mode: 'append' | 'replace' = 'replace'
): SessionSearchIndexUpdate & { result: Promise<SessionSearchIndexResult> } {
  const at = new Date().toISOString()
  const session: AiVaultSession = {
    id: 'fixture',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'fixture',
    title: text,
    cwd: '/fixture',
    branch: null,
    model: null,
    filePath: 'synthetic-transcript',
    codexHome: null,
    createdAt: at,
    updatedAt: at,
    modifiedAt: at,
    messageCount: count,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
  const update: SessionSearchIndexUpdate & { result: Promise<SessionSearchIndexResult> } = {
    candidate: {
      agent: 'claude',
      codexHome: null,
      file: { path: 'synthetic-transcript', mtimeMs: Date.now(), modifiedAt: at, sizeBytes: 2 }
    },
    session,
    mode,
    messages: Array.from({ length: count }, () => ({ role: 'user', text, timestamp: null })),
    previousByteOffset: mode === 'append' ? 1 : 0,
    byteOffset: mode === 'append' ? 2 : 1,
    // Why: callers retarget `session`/`byteOffset` after construction, so the
    // promise the writer awaits must read them then, not at build time.
    result: Promise.resolve().then(() => ({
      session: update.session,
      byteOffset: update.byteOffset
    }))
  }
  return update
}

export type SessionSearchIndexFile = {
  path: string
  /** The store keeps its own connection private, so row assertions need this one. */
  db: SyncDatabase
  close: () => Promise<void>
}

/** An on-disk index: `:memory:` is per-connection, so a second reader needs a real file. */
export async function openSessionSearchIndexFile(name: string): Promise<SessionSearchIndexFile> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  const path = join(root, 'index.sqlite')
  const db = openSessionSearchDatabase(path)
  let open = true
  return {
    path,
    db,
    close: async () => {
      if (open) {
        open = false
        db.close()
      }
      await removeTree(root)
    }
  }
}
