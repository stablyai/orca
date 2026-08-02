import type { ControlledCodexSession } from './codex-controlled-session-registry'

export async function submitControlledInitialTurn(
  session: ControlledCodexSession,
  operationId: string,
  prompt: string,
  assertCanSubmit: () => void
): Promise<void> {
  const key = `initial:${operationId}`
  const prior = session.state.get(key)
  if (prior?.phase === 'finalized') {
    return
  }
  const record = prior ?? {
    operationId,
    clientMessageId: operationId,
    prompt,
    phase: 'accepted' as const,
    codexTurnId: null
  }
  if (record.prompt !== prompt) {
    throw new Error('controlled Codex initial prompt identity mismatch')
  }
  session.state.put(key, record)
  const reconciled = await findClientTurn(session, operationId)
  if (reconciled) {
    session.state.put(key, { ...record, phase: 'finalized', codexTurnId: reconciled })
    return
  }
  if (prior?.phase === 'ambiguous') {
    throw new Error('controlled Codex initial turn remains ambiguous')
  }
  assertCanSubmit()
  try {
    const response = await session.client.request('turn/start', {
      threadId: session.launch.threadId,
      clientUserMessageId: operationId,
      input: [{ type: 'text', text: prompt, text_elements: [] }]
    })
    session.state.put(key, { ...record, phase: 'finalized', codexTurnId: extractTurnId(response) })
  } catch (error) {
    session.state.put(key, { ...record, phase: 'ambiguous' })
    const afterFailure = await findClientTurn(session, operationId)
    if (!afterFailure) {
      throw error
    }
    session.state.put(key, { ...record, phase: 'finalized', codexTurnId: afterFailure })
  }
}

async function findClientTurn(
  session: ControlledCodexSession,
  clientId: string
): Promise<string | null> {
  const response = await session.client.request('thread/read', {
    threadId: session.launch.threadId,
    includeTurns: true
  })
  const turns = isRecord(response) && isRecord(response.thread) ? response.thread.turns : null
  if (!Array.isArray(turns)) {
    return null
  }
  for (const turn of turns) {
    if (!isRecord(turn) || typeof turn.id !== 'string' || !Array.isArray(turn.items)) {
      continue
    }
    if (
      turn.items.some(
        (item) => isRecord(item) && item.type === 'userMessage' && item.clientId === clientId
      )
    ) {
      return turn.id
    }
  }
  return null
}

function extractTurnId(response: unknown): string {
  if (!isRecord(response) || !isRecord(response.turn) || typeof response.turn.id !== 'string') {
    throw new Error('controlled Codex initial turn/start returned an invalid response')
  }
  return response.turn.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
