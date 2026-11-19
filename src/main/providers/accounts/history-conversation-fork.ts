import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { durableWriteTempPath, renameDurable } from '../../filesystem/durable-file-write'
import { readCodexLocalHistory } from '../../native-chat/transcript-history/codex/codex-local-history'
import { readCodexRolloutBytes } from '../../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { splitTranscriptStreamLines } from '../../native-chat/transcript-streaming/transcript-stream-lines'
import { materializeClaudeConversationTranscript } from '../../claude/transcripts/claude-rewind-transcript'
import { copyProfileHistory } from './profile-history-import'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'

export async function forkHistoryConversation(input: {
  provider: 'codex' | 'claude'
  filePath: string
  sessionId: string
  sourceHome: string
  historyRoot: string
  targetHome: string
  historyRoots?: readonly string[]
}): Promise<{ sessionId: string; filePath: string }> {
  if (input.provider === 'claude') {
    const bucket = basename(dirname(input.filePath))
    const copy = await materializeClaudeConversationTranscript({
      sourcePath: input.filePath,
      sourceSessionId: input.sessionId,
      destinationDirectory: join(input.targetHome, 'projects', bucket),
      signal: AbortSignal.timeout(60_000)
    })
    if (!copy) {
      throw new Error(
        'Claude could not create a continuation. The original conversation was preserved.'
      )
    }
    try {
      await copyProfileHistory(
        input.sourceHome,
        input.targetHome,
        [
          {
            source: join(relative(input.sourceHome, dirname(input.filePath)), input.sessionId),
            destination: join('projects', bucket, copy.sessionId)
          },
          {
            source: join('file-history', input.sessionId),
            destination: join('file-history', copy.sessionId)
          }
        ],
        undefined,
        { skipExisting: true }
      )
    } catch (error) {
      await Promise.all([
        rm(copy.filePath, { force: true }),
        rm(join(input.targetHome, 'projects', bucket, copy.sessionId), {
          recursive: true,
          force: true
        }),
        rm(join(input.targetHome, 'file-history', copy.sessionId), {
          recursive: true,
          force: true
        })
      ])
      throw error
    }
    return { sessionId: copy.sessionId, filePath: copy.filePath }
  }
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const stamp = now.slice(0, 19).replaceAll(':', '-')
  const filePath = join(
    input.targetHome,
    'sessions',
    now.slice(0, 4),
    now.slice(5, 7),
    now.slice(8, 10),
    `rollout-${stamp}-${sessionId}.jsonl`
  )
  let metadata: Record<string, unknown> | null = null
  for await (const raw of splitTranscriptStreamLines(readCodexRolloutBytes(input.filePath))) {
    const record = asRecord(JSON.parse(raw.line))
    if (record?.type === 'session_meta') {
      metadata = asRecord(record.payload)
    }
    break
  }
  if (!metadata) {
    throw new Error('Codex could not read the conversation metadata.')
  }
  const { history_base: _base, ...header } = metadata
  const paginated = header.history_mode === 'paginated'
  let ordinal = 1
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = durableWriteTempPath(filePath)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(
      `${JSON.stringify({ type: 'session_meta', ...(paginated ? { ordinal: 0 } : {}), timestamp: now, payload: { ...header, id: sessionId, timestamp: now, forked_from_id: input.sessionId } })}\n`
    )
    await readCodexLocalHistory({
      filePath: input.filePath,
      roots: input.historyRoots ?? [input.historyRoot],
      visit: () => {},
      visitRecord: async ({ record }) => {
        if (!record || record.type === 'session_meta') {
          return
        }
        const payload = asRecord(record.payload)
        await handle.writeFile(
          `${JSON.stringify({
            ...record,
            ...(paginated ? { ordinal: ordinal++ } : {}),
            ...(payload && typeof payload.thread_id === 'string'
              ? { payload: { ...payload, thread_id: sessionId } }
              : {})
          })}\n`
        )
      }
    })
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temporary, { force: true })
    throw error
  }
  await handle.close()
  try {
    await renameDurable(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { sessionId, filePath }
}
