import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { open } from 'node:fs/promises'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeSession } from './claude-structured-session-state'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_COUNT = 20
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

type ImageBudget = {
  count: number
  localBytes: number
}

async function readClaudeImage(path: string): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) {
      throw new Error('Claude image must be a file')
    }
    const buffer = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
    }
    if (bytesRead === 0 || bytesRead > MAX_IMAGE_BYTES) {
      throw new Error(
        `Claude image must be a non-empty file no larger than ${MAX_IMAGE_BYTES} bytes`
      )
    }
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

async function imageContent(
  block: Extract<NativeChatBlock, { type: 'image-ref' }>,
  budget: ImageBudget
): Promise<unknown> {
  budget.count += 1
  if (budget.count > MAX_IMAGE_COUNT) {
    throw new Error(`Claude messages support at most ${MAX_IMAGE_COUNT} images`)
  }
  if (block.url) {
    return { type: 'image', source: { type: 'url', url: block.url } }
  }
  if (!block.path) {
    throw new Error('image reference has neither a path nor a URL')
  }
  const data = await readClaudeImage(block.path)
  budget.localBytes += data.byteLength
  if (budget.localBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(`Claude images must total no more than ${MAX_TOTAL_IMAGE_BYTES} bytes`)
  }
  const mediaType = IMAGE_MIME_BY_EXTENSION[extname(block.path).toLowerCase()]
  if (!mediaType) {
    throw new Error(`Claude does not support the image type ${extname(block.path)}`)
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: data.toString('base64')
    }
  }
}

async function messageContent(body: AgentJournalMessageItem): Promise<unknown[]> {
  if (body.role !== 'user') {
    throw new Error('Claude dispatch accepts only user messages')
  }
  const content: unknown[] = []
  const imageBudget: ImageBudget = { count: 0, localBytes: 0 }
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref') {
      content.push(await imageContent(block, imageBudget))
    }
  }
  if (content.length === 0) {
    throw new Error('Claude dispatch requires text or an image')
  }
  return content
}

type DispatchRace<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: Error }
  | { kind: 'terminal' }

function raceWithSessionTerminal<T>(
  session: ClaudeSession,
  work: Promise<T>
): Promise<DispatchRace<T>> {
  return Promise.race([
    work.then(
      (value): DispatchRace<T> => ({ kind: 'completed', value }),
      (error: unknown): DispatchRace<T> => ({ kind: 'failed', error: error as Error })
    ),
    session.terminal.signal.then<DispatchRace<T>>(() => ({ kind: 'terminal' }))
  ])
}

function acceptedDispatch(session: ClaudeSession, sentUuid: string): AgentSessionDispatchOutcome {
  return {
    state: 'accepted',
    providerIdentity: {
      provider: 'claude',
      sessionId: session.providerSessionId,
      uuid: sentUuid
    }
  }
}

async function acquireDispatchLane(session: ClaudeSession): Promise<() => void> {
  const predecessor = session.dispatchLane
  let release = (): void => {}
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  session.dispatchLane = predecessor.then(() => turn)
  const admission = await Promise.race([
    predecessor.then(() => true),
    session.terminal.signal.then(() => false)
  ])
  if (!admission) {
    release()
    throw new Error('claude structured session closed before dispatch')
  }
  return release
}

export async function dispatchClaudeTurn(
  session: ClaudeSession,
  input: { clientMessageId: string; body: AgentJournalMessageItem }
): Promise<AgentSessionDispatchOutcome> {
  let releaseLane: () => void
  try {
    releaseLane = await acquireDispatchLane(session)
  } catch (error) {
    return { state: 'rejected', reason: (error as Error).message }
  }
  try {
    if (session.terminal.closed) {
      return { state: 'rejected', reason: 'claude structured session closed before dispatch' }
    }
    if (session.dispatchFenced) {
      return {
        state: 'unknown',
        reason: 'claude delivery is uncertain until the session reconnects'
      }
    }
    const materialized = await raceWithSessionTerminal(session, messageContent(input.body))
    if (materialized.kind === 'terminal') {
      return { state: 'rejected', reason: 'claude structured session closed before dispatch' }
    }
    if (materialized.kind === 'failed') {
      return { state: 'rejected', reason: materialized.error.message }
    }
    if (session.terminal.closed) {
      return { state: 'rejected', reason: 'claude structured session closed before dispatch' }
    }
    const sentUuid = randomUUID()
    const sequence = session.sentUserUuidSequence.size
    session.sentUserUuidSequence.set(sentUuid, sequence)
    session.translator?.registerOwnedTurn(session.providerSessionId, sentUuid, sequence)
    const write = await raceWithSessionTerminal(
      session,
      session.connection.send({
        type: 'user',
        uuid: sentUuid,
        message: { role: 'user', content: materialized.value },
        parent_tool_use_id: null,
        session_id: session.providerSessionId
      })
    )
    if (write.kind === 'completed') {
      if (!session.terminal.closed) {
        session.translator?.confirmOwnedTurn(sentUuid)
      }
      return acceptedDispatch(session, sentUuid)
    }
    if (session.deliveryEvidenceUuids.has(sentUuid)) {
      return acceptedDispatch(session, sentUuid)
    }
    if (write.kind === 'terminal') {
      return { state: 'unknown', reason: 'claude session closed while delivery was pending' }
    }
    if (!session.terminal.closed) {
      session.dispatchFenced = true
      session.translator?.abandonOwnedTurn(sentUuid)
    }
    return { state: 'unknown', reason: write.error.message }
  } finally {
    releaseLane()
  }
}
