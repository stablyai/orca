import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import {
  isRecord,
  type AntigravitySwarmTranscriptSummary
} from '../../shared/agent-session/antigravity-swarm-transcript'
import {
  buildAntigravitySwarmSnapshot,
  parseAntigravityMemberTranscript,
  summarizeAntigravityTranscript,
  type AgentSessionSwarmReadResult,
  type AgentSessionSwarmTranscriptResult
} from '../../shared/agent-session/antigravity-swarm-wire'
import { isAntigravityHostAccountHome } from './antigravity-host-acp'

const SAFE_CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,128}$/
const SWARM_FILE_MAX_BYTES = 2 * 1024 * 1024
const TRANSCRIPT_SUMMARY_MAX_BYTES = 256 * 1024
const TRANSCRIPT_VIEW_MAX_BYTES = 512 * 1024

type AntigravitySwarmRecordContext = Pick<
  AgentSessionRecord,
  'provider' | 'providerHandleChain' | 'accountHome' | 'launchedAccount'
>

export function resolveAntigravityBrainDir(
  record: Pick<AgentSessionRecord, 'accountHome' | 'launchedAccount'>,
  homeDir = homedir()
): string {
  const accountHome = record.launchedAccount?.accountHome ?? record.accountHome
  if (isLegacyAgentSessionAccountHome(accountHome)) {
    return isAntigravityHostAccountHome(accountHome)
      ? join(accountHome.path, 'antigravity-cli', 'brain')
      : join(accountHome.path, ANTIGRAVITY_ACP_HOME, 'brain')
  }
  return join(homeDir, '.gemini', 'antigravity-cli', 'brain')
}

function resolveSwarmId(record: Pick<AgentSessionRecord, 'providerHandleChain'>): string | null {
  const nativeId = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle.nativeId
  return nativeId && SAFE_CONVERSATION_ID.test(nativeId) ? nativeId : null
}

async function statSafe(filePath: string) {
  try {
    return await stat(filePath)
  } catch {
    return null
  }
}

async function readTailUtf8(
  filePath: string,
  maxBytes: number
): Promise<{ text: string; truncated: boolean; mtimeMs: number } | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const info = await handle.stat()
    if (!info.isFile()) {
      return null
    }
    const truncated = info.size > maxBytes
    const readLen = truncated ? maxBytes : info.size
    const startPos = truncated ? info.size - maxBytes : 0
    const buf = Buffer.allocUnsafe(readLen)
    let offset = 0
    while (offset < readLen) {
      const { bytesRead } = await handle.read(buf, offset, readLen - offset, startPos + offset)
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    let text = buf.subarray(0, offset).toString('utf8')
    if (truncated) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline !== -1 ? text.slice(firstNewline + 1) : ''
    }
    return { text, truncated, mtimeMs: info.mtimeMs }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function extractMemberConversationIds(membersJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(membersJson)
    if (!isRecord(parsed) || !isRecord(parsed.members)) {
      return []
    }
    const ids = new Set<string>()
    for (const raw of Object.values(parsed.members)) {
      if (!isRecord(raw)) {
        continue
      }
      const conversationId = raw.conversation_id
      if (typeof conversationId === 'string' && SAFE_CONVERSATION_ID.test(conversationId)) {
        ids.add(conversationId)
      }
    }
    return [...ids]
  } catch {
    return []
  }
}

function statToken(info: Awaited<ReturnType<typeof statSafe>>): string {
  return info ? `${info.size}:${Math.trunc(info.mtimeMs)}` : '0:0'
}

export async function readAntigravitySwarmSnapshot(
  record: AntigravitySwarmRecordContext,
  options?: { ifNoneMatch?: string; homeDir?: string; now?: number }
): Promise<AgentSessionSwarmReadResult> {
  if (record.provider !== 'antigravity') {
    return { status: 'unsupported' }
  }
  const swarmId = resolveSwarmId(record)
  if (!swarmId) {
    return { status: 'none' }
  }

  const brainDir = resolveAntigravityBrainDir(record, options?.homeDir)
  const swarmDir = join(brainDir, swarmId, '.system_generated', 'swarm')
  const membersPath = join(swarmDir, 'members.json')
  const membersData = await readTailUtf8(membersPath, SWARM_FILE_MAX_BYTES)
  if (!membersData) {
    return { status: 'none' }
  }

  const boardPath = join(swarmDir, 'board.jsonl')
  const planPath = join(swarmDir, 'plan.json')
  const conversationIds = extractMemberConversationIds(membersData.text)

  const [boardStat, planStat, ...transcriptStats] = await Promise.all([
    statSafe(boardPath),
    statSafe(planPath),
    ...conversationIds.map((conversationId) =>
      statSafe(join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl'))
    )
  ])

  const signature = [
    `m=${membersData.text.length}:${Math.trunc(membersData.mtimeMs)}`,
    `b=${statToken(boardStat)}`,
    `p=${statToken(planStat)}`,
    ...conversationIds.map((id, index) => `${id}=${statToken(transcriptStats[index] ?? null)}`)
  ].join('|')
  const etag = createHash('sha1').update(signature).digest('hex').slice(0, 20)

  if (options?.ifNoneMatch && options.ifNoneMatch === etag) {
    return { status: 'unchanged', etag }
  }

  const [boardData, planData, ...transcriptDatas] = await Promise.all([
    boardStat ? readTailUtf8(boardPath, SWARM_FILE_MAX_BYTES) : Promise.resolve(null),
    planStat ? readTailUtf8(planPath, SWARM_FILE_MAX_BYTES) : Promise.resolve(null),
    ...conversationIds.map((conversationId, index) =>
      transcriptStats[index]
        ? readTailUtf8(
            join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl'),
            TRANSCRIPT_SUMMARY_MAX_BYTES
          )
        : Promise.resolve(null)
    )
  ])

  const transcriptByConversationId = new Map<string, AntigravitySwarmTranscriptSummary>()
  conversationIds.forEach((conversationId, index) => {
    const data = transcriptDatas[index]
    if (data) {
      transcriptByConversationId.set(
        conversationId,
        summarizeAntigravityTranscript(data.text, data.mtimeMs)
      )
    }
  })

  const snapshot = buildAntigravitySwarmSnapshot({
    swarmId,
    etag,
    membersJson: membersData.text,
    boardJsonl: boardData?.text ?? '',
    planJson: planData?.text ?? null,
    transcriptByConversationId,
    now: options?.now
  })

  if (!snapshot) {
    return { status: 'none' }
  }
  return { status: 'ok', snapshot }
}

export async function readAntigravitySwarmMemberTranscript(
  record: AntigravitySwarmRecordContext,
  args: { conversationId: string; maxEntries?: number; homeDir?: string }
): Promise<AgentSessionSwarmTranscriptResult> {
  if (record.provider !== 'antigravity') {
    return { status: 'unsupported' }
  }
  if (!SAFE_CONVERSATION_ID.test(args.conversationId)) {
    return { status: 'none' }
  }
  const swarmId = resolveSwarmId(record)
  if (!swarmId) {
    return { status: 'none' }
  }

  const brainDir = resolveAntigravityBrainDir(record, args.homeDir)
  if (args.conversationId !== swarmId) {
    const membersData = await readTailUtf8(
      join(brainDir, swarmId, '.system_generated', 'swarm', 'members.json'),
      SWARM_FILE_MAX_BYTES
    )
    if (
      !membersData ||
      !extractMemberConversationIds(membersData.text).includes(args.conversationId)
    ) {
      return { status: 'none' }
    }
  }

  const transcriptPath = join(
    brainDir,
    args.conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  )
  const data = await readTailUtf8(transcriptPath, TRANSCRIPT_VIEW_MAX_BYTES)
  if (!data) {
    return { status: 'none' }
  }
  const allEntries = parseAntigravityMemberTranscript(data.text)
  const limit = args.maxEntries
  const capped = typeof limit === 'number' && allEntries.length > limit
  const entries = capped ? allEntries.slice(-limit) : allEntries
  return {
    status: 'ok',
    conversationId: args.conversationId,
    entries,
    truncated: data.truncated || capped
  }
}
