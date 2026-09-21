import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { TranscriptMessageChannel } from '../ai-vault/session-transcript-channel'
import type {
  TranscriptMessage,
  TranscriptReadOutcome,
  TranscriptReadStart
} from '../ai-vault/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import { openSessionSearchDatabase } from './session-search-schema'

export const SYNTHETIC_TRANSCRIPT = 'synthetic-transcript'

export function syntheticCandidate(
  overrides: Partial<SessionFileCandidate['file']> = {}
): SessionFileCandidate {
  const at = new Date(1740000000000)
  return {
    agent: 'claude',
    codexHome: null,
    file: {
      path: SYNTHETIC_TRANSCRIPT,
      mtimeMs: at.getTime(),
      modifiedAt: at.toISOString(),
      sizeBytes: 4096,
      ...overrides
    }
  }
}

export function syntheticSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  const at = new Date(1740000000000).toISOString()
  return {
    id: 'fixture',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'fixture',
    title: 'fixture session',
    cwd: '/fixture',
    branch: null,
    model: null,
    filePath: SYNTHETIC_TRANSCRIPT,
    codexHome: null,
    createdAt: at,
    updatedAt: at,
    modifiedAt: at,
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

export function userMessages(text: string, count: number): TranscriptMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    role: 'user' as const,
    text,
    timestamp: new Date(1740000000000 + index * 1000).toISOString()
  }))
}

/**
 * Drives one read through the real fan-out channel, so a test exercises the
 * registration path the transcript reader uses rather than the consumer alone.
 */
export function replayTranscriptRead(args: {
  candidate?: SessionFileCandidate
  mode?: TranscriptReadStart['mode']
  previousByteOffset?: number
  messages: TranscriptMessage[]
  outcome?: Partial<TranscriptReadOutcome>
}): void {
  const candidate = args.candidate ?? syntheticCandidate()
  const mode = args.mode ?? 'replace'
  const channel = new TranscriptMessageChannel()
  channel.beginRead({
    candidate,
    mode,
    previousByteOffset: args.previousByteOffset ?? 0
  })
  for (const message of args.messages) {
    channel.push(message)
  }
  channel.finishRead({
    session: syntheticSession(),
    byteOffset: 4096,
    incomplete: false,
    ...args.outcome
  })
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
