import {
  waitForClaudeImportQuiet,
  type ClaudeSourceVersion
} from './journal-claude-import-source-version'
import type { JournalSqlDatabase } from '../database/journal-sql-database'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSqlOwner } from '../journal-sql-owner'
import type { JournalOperationReceipt } from '../writing/journal-row-writer'
import type { SqlAgentSessionJournal } from '../journal-sql-store'
import {
  importClaudeTranscriptInWorker,
  type ClaudeImportWorker
} from './journal-claude-import-worker'
import {
  LEGACY_IMPORT_BLOCK_LIMITS,
  MAX_LEGACY_IMPORT_RETAINED_BYTES
} from './journal-transcript-import-limits'
import type { ClaudeImportWork } from './journal-claude-import-worker-protocol'
import {
  ClaudeImportResourceError,
  ClaudeImportGrowthError,
  type ClaudeImportGrowth
} from './journal-claude-import-resource-error'

export type ClaudeImportAuthority = {
  sessionId: string
  operationId: string
  fingerprint: string
}
export type ClaudeImportInstall = ClaudeImportAuthority & {
  token: string
  count: number
  cursor: AgentJournalCursor
  version: ClaudeSourceVersion
  cancelled: Int32Array<SharedArrayBuffer>
}
export type ClaudeImportStage = {
  count: number
  sourceEmpty: boolean
  install(
    journal: Pick<SqlAgentSessionJournal, 'physicalCursor' | 'write'>,
    fence: number,
    receipt?: JournalOperationReceipt
  ): ReturnType<SqlAgentSessionJournal['write']>
  close(): Promise<void>
}
export type PrepareClaudeImport = (
  input: Omit<ClaudeImportWork, 'limits' | 'retainedBytes' | 'growth'> &
    Pick<Partial<ClaudeImportWork>, 'limits'> & { signal?: AbortSignal },
  authority: ClaudeImportAuthority
) => Promise<ClaudeImportStage>

export function journalClaudeImport(database: JournalSqlDatabase): PrepareClaudeImport {
  return (input, authority) =>
    stageClaudeImport(
      {
        maintain: (operation) =>
          database.serialize(authority.sessionId, (writer) => writer.maintain(operation))
      },
      input,
      authority
    )
}

export async function stageClaudeImport(
  writer: Pick<JournalSqlOwner, 'maintain'>,
  input: Parameters<PrepareClaudeImport>[0],
  authority: ClaudeImportAuthority
): Promise<ClaudeImportStage> {
  let token: string | undefined
  let worker: ClaudeImportWorker | undefined
  let growth: ClaudeImportGrowth | undefined
  let discarding: Promise<void> | undefined
  const discard = () =>
    (discarding ??= (async () => {
      try {
        await worker?.close()
      } finally {
        worker = undefined
        if (token) {
          await writer.maintain({ kind: 'fork-abort', token })
          token = undefined
        }
      }
    })())
  const restage = async (error: unknown) => {
    await discard()
    if (!(error instanceof ClaudeImportGrowthError) || growth) {
      throw error
    }
    growth = await waitForClaudeImportQuiet(input.filePath, error.growth, input.signal)
  }
  const prepare = async () => {
    for (;;) {
      discarding = undefined
      try {
        worker = await importClaudeTranscriptInWorker(
          {
            ...input,
            growth,
            limits: input.limits ?? LEGACY_IMPORT_BLOCK_LIMITS,
            retainedBytes: MAX_LEGACY_IMPORT_RETAINED_BYTES
          },
          async (bytes, ordinal, header) => {
            if (!token) {
              const stage = await writer.maintain({
                kind: 'import-stage-begin',
                authority,
                count: header.count
              })
              if (!stage || typeof stage !== 'object' || !('token' in stage)) {
                throw new Error('Journal writer did not create a history import stage.')
              }
              token = stage.token
            }
            await writer.maintain({ kind: 'import-stage-page', token, ordinal, bytes })
          }
        )
        if (worker.count > 0 && !token) {
          throw new ClaudeImportResourceError('Claude history import did not receive its pages.')
        }
        return worker
      } catch (error) {
        await restage(error)
      }
    }
  }
  let prepared = await prepare()
  return {
    count: prepared.count,
    sourceEmpty: prepared.sourceEmpty,
    async install(journal, fence, receipt) {
      const cursor = journal.physicalCursor()
      const cancelled = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
      const cancel = () => Atomics.store(cancelled, 0, 1)
      input.signal?.addEventListener('abort', cancel, { once: true })
      try {
        for (;;) {
          input.signal?.throwIfAborted()
          const stageToken = token
          if (!stageToken) {
            throw new ClaudeImportResourceError('Claude history import has no staged items.')
          }
          try {
            const commit = await journal.write(
              { kind: 'epoch-replace', reason: 'legacy_import', fence, items: [] },
              async () => {
                const version = await prepared.verify()
                input.signal?.throwIfAborted()
                return {
                  claudeImport: {
                    ...authority,
                    token: stageToken,
                    count: prepared.count,
                    cursor,
                    version,
                    cancelled
                  },
                  receipt
                }
              }
            )
            token = undefined
            return commit
          } catch (error) {
            await restage(error)
            prepared = await prepare()
          }
        }
      } finally {
        input.signal?.removeEventListener('abort', cancel)
        await discard()
      }
    },
    close: discard
  }
}
