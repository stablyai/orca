// Completed diff originals written once into one seeded chat through the seed arm's own original journal writer, after
// that arm has stopped and before its seed is renamed or copied, so every arm starts from the same rows and item IDs.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { bundleFromCheckout, type Arm } from './native-chat-4a-arm'
import { history } from './native-chat-4a-session'
import { diffPatch, type Workload } from './native-chat-4a-workloads'

const JOURNAL = 'src/main/native-chat/agent-session-journal'
const ORIGINAL_STORE_FILE = 'agent-session-journal.db'
// The original store's owner and writer; a checkout without them (the SQL candidate) cannot write this seed.
const WRITER_SOURCES = [
  ['{ JournalHostDatabase }', `${JOURNAL}/database/journal-host-database.ts`],
  ['{ openAgentSessionJournal }', `${JOURNAL}/journal-store-factory.ts`],
  ['{ journalPayload }', `${JOURNAL}/item-lifecycle/journal-payload-bounds.ts`],
  [
    '{ decodePersistedAgentSessionProviderHandle }',
    'src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding.ts'
  ]
] as const

type TurnScope = { kind: 'turn'; turnItemId: string }
type ProviderHandle = { nativeId: string }
type HostDatabase = {
  db: { prepare(sql: string): { get(...params: string[]): Record<string, unknown> | undefined } }
  close(): Promise<void>
}
type OriginalJournal = {
  readonly epoch: string
  appendItem(
    identity: { provider: 'claude'; sessionId: string; uuid: string },
    body: { kind: 'diff'; path: string; patch: unknown },
    options: { fence: number; turnScope: TurnScope }
  ): Promise<{ cursor: { epoch: string }; itemId: string }>
  close(): Promise<void>
}
type OriginalWriter = {
  JournalHostDatabase: { open(stateDirectory: string): HostDatabase }
  openAgentSessionJournal(options: {
    identity: {
      sessionId: string
      workspaceId: string
      hostId: string
      agent: string
      providerHandle: ProviderHandle
    }
    database: HostDatabase
  }): Promise<OriginalJournal>
  journalPayload(payload: string): unknown
  decodePersistedAgentSessionProviderHandle(value: unknown): ProviderHandle | null
}
type StoredRecord = {
  provider?: unknown
  location?: { workspaceId?: unknown; executionHostId?: unknown }
  providerHandleChain?: { handle?: unknown }[]
}

/** The chat as its writing arm served it before stopping: epoch, fence and the provider turn new rows join. */
export type DiffTarget = {
  sessionId: string
  epoch: string
  fence: number
  providerSessionId: string
  turnScope: TurnScope
}

export type DiffChat = {
  sessionId: string
  /** Known item IDs, in write order; every arm verifies these exact rows before sampling. */
  itemIds: string[]
  patchBytes: number
  /** sha256 of each original patch, in write order. */
  digests: string[]
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The patches this harness generates for `chat`, or null when they are not the ones its seed wrote. */
export function seededPatches(chat: DiffChat): string[] | null {
  const patches = chat.itemIds.map((_, index) => diffPatch(index, chat.patchBytes).patch)
  return patches.every((patch, index) => sha256(patch) === chat.digests[index]) ? patches : null
}

/** A stable provider-shaped UUID per chat and index, so a reseed names the same rows. */
function diffItemUuid(sessionId: string, index: number): string {
  const hex = sha256(`4a-diff:${sessionId}:${index}`)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}

function turnScopeOf(item: unknown): TurnScope | null {
  const scope =
    typeof item === 'object' && item !== null && 'turnScope' in item ? item.turnScope : null
  return typeof scope === 'object' &&
    scope !== null &&
    'kind' in scope &&
    scope.kind === 'turn' &&
    'turnItemId' in scope &&
    typeof scope.turnItemId === 'string'
    ? { kind: 'turn', turnItemId: scope.turnItemId }
    : null
}

/** Read the chat's epoch, fence and last provider turn through its history route while its arm still serves it. */
export async function captureDiffTarget(page: Page, sessionId: string): Promise<DiffTarget> {
  const tail = await history(page, sessionId, 'tail', 40)
  const fence = tail.page.fence ?? tail.value.fence
  const owned = tail.page.items.findLast(
    (item) => item.itemId.startsWith('claude:') && turnScopeOf(item)
  )
  if (typeof fence !== 'number' || !owned) {
    throw new Error(`${sessionId}: history served no fence or no provider row with a turn scope`)
  }
  return {
    sessionId,
    epoch: tail.page.epoch,
    fence,
    providerSessionId: decodeURIComponent(owned.itemId.split(':')[1] ?? ''),
    turnScope: turnScopeOf(owned)!
  }
}

/** The journal identity the host derives from the stored record; its provider handle must name the captured session. */
function storedIdentity(writer: OriginalWriter, database: HostDatabase, target: DiffTarget) {
  const row = database.db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
    .get(target.sessionId)
  const record: StoredRecord =
    typeof row?.record_json === 'string' ? JSON.parse(row.record_json) : {}
  const { workspaceId, executionHostId } = record.location ?? {}
  const providerHandle = writer.decodePersistedAgentSessionProviderHandle(
    record.providerHandleChain?.at(-1)?.handle
  )
  if (
    typeof workspaceId !== 'string' ||
    typeof executionHostId !== 'string' ||
    typeof record.provider !== 'string' ||
    providerHandle?.nativeId !== target.providerSessionId
  ) {
    throw new Error(
      `${target.sessionId}: the stored record does not name the provider session its history served`
    )
  }
  return {
    sessionId: target.sessionId,
    workspaceId,
    hostId: executionHostId,
    agent: record.provider,
    providerHandle
  }
}

/** Append the workload's known diffs once; the seed arm must be stopped, and every owner here closes before returning. */
export async function writeSeedDiffs(input: {
  arm: Arm
  scratch: string
  profileDir: string
  target: DiffTarget
  workload: Workload
}): Promise<DiffChat> {
  const { arm, target } = input
  const { count, patchBytes } = input.workload.diffs
  if (!existsSync(path.join(input.profileDir, ORIGINAL_STORE_FILE))) {
    throw new Error(
      `${arm.name}: the seed holds no ${ORIGINAL_STORE_FILE}; seed from the baseline arm`
    )
  }
  const writer = await bundleFromCheckout<OriginalWriter>(
    arm.root,
    path.join(input.scratch, `${arm.name}-original-writer.cjs`),
    WRITER_SOURCES
  ).catch((error: unknown) => {
    throw new Error(`${arm.name}: its checkout has no original journal writer to seed diffs with`, {
      cause: error
    })
  })
  const database = writer.JournalHostDatabase.open(input.profileDir)
  try {
    const journal = await writer.openAgentSessionJournal({
      identity: storedIdentity(writer, database, target),
      database
    })
    try {
      if (journal.epoch !== target.epoch) {
        throw new Error(
          `${target.sessionId}: the writer opened epoch ${journal.epoch}, not ${target.epoch}`
        )
      }
      const chat: DiffChat = { sessionId: target.sessionId, itemIds: [], patchBytes, digests: [] }
      for (let index = 0; index < count; index += 1) {
        const { path: file, patch } = diffPatch(index, patchBytes)
        const appended = await journal.appendItem(
          {
            provider: 'claude',
            sessionId: target.providerSessionId,
            uuid: diffItemUuid(target.sessionId, index)
          },
          { kind: 'diff', path: file, patch: writer.journalPayload(patch) },
          { fence: target.fence, turnScope: target.turnScope }
        )
        if (appended.cursor.epoch !== target.epoch) {
          throw new Error(`${target.sessionId}: a diff landed in epoch ${appended.cursor.epoch}`)
        }
        chat.itemIds.push(appended.itemId)
        chat.digests.push(sha256(patch))
      }
      return chat
    } finally {
      await journal.close()
    }
  } finally {
    await database.close()
  }
}
