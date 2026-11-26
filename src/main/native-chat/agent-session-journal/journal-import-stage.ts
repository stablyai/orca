import { statSync } from 'node:fs'
import { agentSessionRefusalError } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { ClaudeImportGrowthError } from './history-import/journal-claude-import-resource-error'
import type {
  ClaudeImportAuthority,
  ClaudeImportInstall
} from './history-import/journal-claude-import-stage'
import { CLAUDE_IMPORT_PAGE_DATA_BYTES } from './history-import/journal-claude-import-worker-protocol'
import { MAX_LEGACY_IMPORT_RETAINED_BYTES } from './history-import/journal-transcript-import-limits'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalForkStageOperation, JournalForkStageResult } from './journal-fork-stages'
import { assertJournalFence } from './writing/journal-write-guards'

export type ImportStage = {
  authority: ClaudeImportAuthority
  count: number
  ordinal: number
  size: number
  lines: number
  page?: ImportStagePage
}

export function applyJournalImportStage(
  imports: Map<string, ImportStage>,
  operation: Extract<
    JournalForkStageOperation,
    { kind: 'import-stage-begin' | 'import-stage-page' }
  >
): JournalForkStageResult {
  if (operation.kind === 'import-stage-begin') {
    if (!Number.isSafeInteger(operation.count) || operation.count <= 0) {
      throw new Error('Invalid journal import item count.')
    }
    const token = randomUUID()
    imports.set(token, {
      authority: operation.authority,
      count: operation.count,
      ordinal: 0,
      size: 0,
      lines: 0
    })
    return { token }
  }

  const stage = imports.get(operation.token)
  if (
    !stage ||
    stage.ordinal !== operation.ordinal ||
    !operation.bytes.length ||
    operation.bytes.length > CLAUDE_IMPORT_PAGE_DATA_BYTES
  ) {
    throw new Error('Journal import page does not match its private stage.')
  }
  const { buffer, byteOffset, byteLength } = operation.bytes
  const bytes = Buffer.from(buffer, byteOffset, byteLength)
  let lines = stage.lines
  for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) {
    lines++
  }
  const size = stage.size + byteLength
  if (lines > stage.count || size - lines > MAX_LEGACY_IMPORT_RETAINED_BYTES) {
    throw new Error('Journal import page exceeds its private stage budget.')
  }
  imports.set(operation.token, {
    ...stage,
    ordinal: stage.ordinal + 1,
    size,
    lines,
    page: { prior: stage.page, bytes: operation.bytes }
  })
  return null
}

export function assertJournalImportCurrent(install: ClaudeImportInstall): void {
  if (Atomics.load(install.cancelled, 0)) {
    throw agentSessionRefusalError(
      'agent_session_identity_required',
      { reason: 'transcriptUnreadable' },
      'Claude history import was cancelled.'
    )
  }
  const { version } = install
  const path = statSync(version.path, { bigint: true, throwIfNoEntry: false })
  if (
    path?.isFile() &&
    path.dev === version.device &&
    path.ino === version.inode &&
    path.size > version.size
  ) {
    const { size, device, inode, digest } = version
    throw new ClaudeImportGrowthError({
      prefix: { size, device, inode, digest },
      minimumSize: path.size
    })
  }
  if (
    !path?.isFile() ||
    path.size !== version.size ||
    path.dev !== version.device ||
    path.ino !== version.inode ||
    path.mtimeNs !== version.modified ||
    path.ctimeNs !== version.changed
  ) {
    throw agentSessionRefusalError(
      'agent_session_identity_required',
      { reason: 'transcriptUnreadable' },
      'Claude transcript changed during history import.'
    )
  }
}

export function installJournalImportStage(
  db: Database.Database,
  imports: Map<string, ImportStage>,
  command: JournalWriterCommand,
  install: ClaudeImportInstall
): JournalWriterCommand {
  const stage = imports.get(install.token)
  const { target, operation } = command
  if (
    !stage ||
    stage.count !== install.count ||
    stage.authority.sessionId !== target.sessionId ||
    install.sessionId !== target.sessionId ||
    stage.authority.operationId !== install.operationId ||
    stage.authority.fingerprint !== install.fingerprint ||
    operation.kind !== 'epoch-replace' ||
    operation.reason !== 'legacy_import' ||
    operation.items.length !== 0 ||
    install.cursor.epoch !== target.epoch
  ) {
    throw new Error('Journal import installation does not match its completed stage.')
  }
  const head = db
    .prepare(
      'SELECT last_sequence, highest_fence FROM journal_chat_state WHERE session_id=? AND epoch=?'
    )
    .get(target.sessionId, target.epoch)
  if (!head || Number(head.last_sequence) !== install.cursor.sequence) {
    throw new Error('The journal changed before history import could install.')
  }
  assertJournalFence(operation.fence, Number(head.highest_fence))
  for (const effect of command.effects ?? []) {
    if (
      effect.kind === 'store' &&
      effect.mutation.input.kind === 'command' &&
      effect.mutation.input.command.kind === 'found'
    ) {
      const { request } = effect.mutation.input.command
      if (
        request.sessionId !== install.sessionId ||
        request.operation.operationId !== install.operationId ||
        request.operation.fingerprint !== install.fingerprint
      ) {
        throw new Error('Journal import founding identity changed.')
      }
    }
  }
  assertJournalImportCurrent(install)
  const items = stagedClaudeItems(stage.page, stage.size, stage.count)
  imports.delete(install.token)
  return { ...command, operation: { ...operation, items } }
}

type ImportStagePage = { prior?: ImportStagePage; bytes: Uint8Array }

/** Parse on the writer. Oversize items can span multiple opaque pages. */
function stagedClaudeItems(page: ImportStagePage | undefined, size: number, count: number) {
  const stream = Buffer.allocUnsafeSlow(size)
  let offset = size
  for (; page; page = page.prior) {
    offset -= page.bytes.length
    stream.set(page.bytes, offset)
  }
  const items: JournalReplacementItem[] = []
  for (let start = 0; start < size;) {
    const end = stream.indexOf(10, start)
    if (end === -1) {
      throw new Error('Journal import stage ended inside a record.')
    }
    items.push(JSON.parse(stream.toString('utf8', start, end)))
    start = end + 1
  }
  if (items.length !== count) {
    throw new Error('Journal import stage item count changed.')
  }
  return items
}
