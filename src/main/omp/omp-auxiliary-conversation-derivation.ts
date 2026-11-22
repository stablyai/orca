import { randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, link, open, readFile, rm, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { isRecord } from '../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import { OmpAuxiliaryDerivationError } from './omp-auxiliary-conversation-error'
import {
  readOmpSessionBranch,
  type OmpSessionEntry,
  type OmpSessionHeader
} from './omp-v3-session-branch-reader'

export { OmpAuxiliaryDerivationError } from './omp-auxiliary-conversation-error'
export type { OmpAuxiliaryDerivationErrorCode } from './omp-auxiliary-conversation-error'

const SESSION_TITLE_SLOT_BYTES = 256
const SESSION_VERSION = 3
const DATE_CWD_REMINDER_ENTRY_TYPE = 'date-cwd-reminder'

/** The ZCode selection side-chat boundary, verbatim. */
const SELECTION_SIDE_CHAT_BOUNDARY = [
  'The preceding conversation was inherited from the parent task for reference only.',
  "Do not continue the parent's active work automatically; answer only new questions sent in this side chat.",
  'Modify the workspace only when the user explicitly asks you to do so in this side chat.'
].join(' ')

const SELECTION_SIDE_CHAT_BOUNDARY_REMINDER = [
  '<system-reminder>',
  SELECTION_SIDE_CHAT_BOUNDARY,
  '</system-reminder>'
].join('\n')

export type OmpAuxiliaryConversation = {
  sessionId: string
  filePath: string
  discard: () => Promise<void>
}

function invalidSource(message: string): never {
  throw new OmpAuxiliaryDerivationError('invalid-source', message)
}

function latestUserIndex(entries: readonly OmpSessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index].message
    if (entries[index].type === 'message' && isRecord(message) && message.role === 'user') {
      return index
    }
  }
  return -1
}

function shouldInheritEntry(entry: OmpSessionEntry): boolean {
  const customType = entry.customType
  if (typeof customType === 'string' && customType.startsWith('goal')) {
    return false
  }
  switch (entry.type) {
    case 'message':
    case 'custom_message':
    case 'branch_summary':
    case 'compaction':
    case 'reset_boundary':
    case 'model_change':
    case 'thinking_level_change':
    case 'service_tier_change':
      return true
    case 'mode_change':
      return !(typeof entry.mode === 'string' && entry.mode.startsWith('goal'))
    case 'custom':
      // The reminder journal is provider-visible request bytes; other custom rows are runtime-only.
      return customType === DATE_CWD_REMINDER_ENTRY_TYPE
    default:
      return false
  }
}

function serializeTitleSlot(updatedAt: string): string {
  const base = { type: 'title', v: 1, title: '', updatedAt, pad: '' }
  const padBytes = SESSION_TITLE_SLOT_BYTES - Buffer.byteLength(`${JSON.stringify(base)}\n`)
  if (padBytes < 0) {
    throw new OmpAuxiliaryDerivationError(
      'write-failed',
      'OMP session title slot metadata exceeds its fixed size'
    )
  }
  const line = `${JSON.stringify({ ...base, pad: ' '.repeat(padBytes) })}\n`
  if (Buffer.byteLength(line) !== SESSION_TITLE_SLOT_BYTES) {
    throw new OmpAuxiliaryDerivationError(
      'write-failed',
      'OMP session title slot serialization did not produce a fixed-width line'
    )
  }
  return line
}

function mintSessionId(): string {
  const random = randomBytes(16)
  const milliseconds = BigInt(Date.now())
  random[0] = Number((milliseconds >> 40n) & 0xffn)
  random[1] = Number((milliseconds >> 32n) & 0xffn)
  random[2] = Number((milliseconds >> 24n) & 0xffn)
  random[3] = Number((milliseconds >> 16n) & 0xffn)
  random[4] = Number((milliseconds >> 8n) & 0xffn)
  random[5] = Number(milliseconds & 0xffn)
  random[6] = (random[6] & 0x0f) | 0x70
  random[8] = (random[8] & 0x3f) | 0x80
  const hex = random.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function mintEntryId(usedIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = randomUUID().slice(-8)
    if (!usedIds.has(id)) {
      usedIds.add(id)
      return id
    }
  }
  throw new OmpAuxiliaryDerivationError(
    'write-failed',
    'Could not mint a unique OMP session entry id'
  )
}

function buildSessionContent(input: {
  header: OmpSessionHeader
  inherited: readonly OmpSessionEntry[]
  sessionId: string
  timestamp: string
}): string {
  const providerPromptCacheKey =
    input.header.taskPromptCacheKey !== undefined
      ? undefined
      : (input.header.providerPromptCacheKey ?? input.header.id)
  const additionalDirectories = input.header.additionalDirectories ?? []
  const header = {
    type: 'session',
    version: SESSION_VERSION,
    id: input.sessionId,
    timestamp: input.timestamp,
    cwd: resolve(input.header.cwd),
    ...(additionalDirectories.length > 0
      ? { additionalDirectories: [...additionalDirectories] }
      : {}),
    parentSession: input.header.id,
    ...(providerPromptCacheKey === undefined ? {} : { providerPromptCacheKey }),
    ...(input.header.taskPromptCacheKey === undefined
      ? {}
      : { taskPromptCacheKey: input.header.taskPromptCacheKey })
  }
  const lines = [serializeTitleSlot(input.timestamp), `${JSON.stringify(header)}\n`]
  const usedIds = new Set(input.inherited.map((entry) => entry.id))
  let parentId: string | null = null
  for (const entry of input.inherited) {
    const copy = { ...entry, parentId }
    delete copy.activeLeafId
    lines.push(`${JSON.stringify(copy)}\n`)
    parentId = entry.id
  }
  lines.push(
    `${JSON.stringify({
      type: 'message',
      id: mintEntryId(usedIds),
      parentId,
      timestamp: input.timestamp,
      message: {
        role: 'user',
        content: SELECTION_SIDE_CHAT_BOUNDARY_REMINDER,
        synthetic: true,
        attribution: 'agent',
        timestamp: Date.parse(input.timestamp)
      }
    })}\n`
  )
  return lines.join('')
}

function isFileSystemCode(error: unknown, codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  )
}

async function writeSessionFileAtomically(filePath: string, content: string): Promise<void> {
  const stagingPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`
  )
  let handle: FileHandle | undefined
  try {
    handle = await open(stagingPath, 'wx')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {})
      await rm(stagingPath, { force: true }).catch(() => {})
    }
    throw error
  }
  if (handle) {
    await handle.close().catch(() => {})
  }
  try {
    await link(stagingPath, filePath)
  } catch (error) {
    if (
      !isFileSystemCode(error, [
        'EPERM',
        'EACCES',
        'ENOTSUP',
        'EOPNOTSUPP',
        'ENOSYS',
        'EXDEV',
        'EMLINK'
      ])
    ) {
      await rm(stagingPath, { force: true }).catch(() => {})
      throw error
    }
    try {
      await copyFile(stagingPath, filePath, fsConstants.COPYFILE_EXCL)
    } finally {
      await rm(stagingPath, { force: true }).catch(() => {})
    }
    return
  }
  await unlink(stagingPath).catch(() => {})
}

async function validateSourcePath(sourcePath: string): Promise<string> {
  if (
    typeof sourcePath !== 'string' ||
    sourcePath.length === 0 ||
    sourcePath.includes('\0') ||
    !isAbsolute(sourcePath) ||
    extname(sourcePath).toLowerCase() !== '.jsonl'
  ) {
    invalidSource('OMP auxiliary source must be an absolute .jsonl path')
  }
  const resolved = resolve(sourcePath)
  const sourceStat = await stat(resolved).catch(() => undefined)
  if (!sourceStat?.isFile()) {
    invalidSource(`OMP auxiliary source is not a readable regular file: ${resolved}`)
  }
  return resolved
}

export async function deriveOmpAuxiliaryConversation(input: {
  sourcePath: string
  sourceNativeId: string
  working: boolean
}): Promise<OmpAuxiliaryConversation> {
  const resolvedSourcePath = await validateSourcePath(input.sourcePath)
  if (typeof input.sourceNativeId !== 'string' || input.sourceNativeId.length === 0) {
    invalidSource('OMP auxiliary source native id is required')
  }
  if (typeof input.working !== 'boolean') {
    invalidSource('OMP auxiliary working state must be boolean')
  }
  const { header, branch } = readOmpSessionBranch(
    await readFile(resolvedSourcePath, 'utf8'),
    resolvedSourcePath
  )
  if (header.id !== input.sourceNativeId) {
    throw new OmpAuxiliaryDerivationError(
      'session-mismatch',
      `OMP session header id ${header.id} does not match source native id ${input.sourceNativeId}`
    )
  }
  let boundaryIndex = branch.length - 1
  if (input.working) {
    const userIndex = latestUserIndex(branch)
    if (userIndex >= 0) {
      boundaryIndex = userIndex
    } else if (branch.length > 0) {
      throw new OmpAuxiliaryDerivationError(
        'unstable-boundary',
        'OMP parent turn is working but its active branch has no committed user message'
      )
    }
  }
  const inherited = branch.slice(0, boundaryIndex + 1).filter(shouldInheritEntry)
  const timestamp = new Date().toISOString()
  const sessionId = mintSessionId()
  const filePath = join(
    dirname(resolvedSourcePath),
    `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`
  )
  await writeSessionFileAtomically(
    filePath,
    buildSessionContent({ header, inherited, sessionId, timestamp })
  )
  return {
    sessionId,
    filePath,
    discard: async () => {
      await rm(filePath, { force: true })
    }
  }
}
