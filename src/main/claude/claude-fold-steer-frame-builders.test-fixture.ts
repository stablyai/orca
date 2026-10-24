// Rebuild fold-steer captures with only dispatch and turn fields.

export type CapturedFoldFrame = { at: number; frame: Record<string, unknown> }

export type FoldCaptureIds = {
  sessionId: string
  /** Turn-opening client UUID adopted by the replay. */
  first: string
  steer: string
  /** Present only for two-steer captures. */
  secondSteer?: string
}

export function userReplay(
  at: number,
  sessionId: string,
  uuid: string,
  text: string
): CapturedFoldFrame {
  return {
    at,
    frame: {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      uuid,
      isReplay: true,
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
  }
}

export function assistant(
  at: number,
  sessionId: string,
  uuid: string,
  content: unknown[],
  userMessageUuids?: string[]
): CapturedFoldFrame {
  return {
    at,
    frame: {
      type: 'assistant',
      session_id: sessionId,
      parent_tool_use_id: null,
      uuid,
      message: { id: `msg-${uuid}`, role: 'assistant', content },
      ...(userMessageUuids && userMessageUuids.length > 0
        ? { user_message_uuid: userMessageUuids[0], user_message_uuids: userMessageUuids }
        : {})
    }
  }
}

export function assistantToolUse(
  at: number,
  sessionId: string,
  uuid: string,
  toolUseId: string,
  userMessageUuids?: string[]
): CapturedFoldFrame {
  return assistant(
    at,
    sessionId,
    uuid,
    [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep 5' } }],
    userMessageUuids
  )
}

export function assistantText(
  at: number,
  sessionId: string,
  uuid: string,
  text: string,
  userMessageUuids?: string[]
): CapturedFoldFrame {
  return assistant(at, sessionId, uuid, [{ type: 'text', text }], userMessageUuids)
}

export function toolResult(
  at: number,
  sessionId: string,
  uuid: string,
  toolUseId: string,
  content = '(Bash completed with no output)',
  isError = false
): CapturedFoldFrame {
  return {
    at,
    frame: {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      uuid,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
      }
    }
  }
}

export function resultFrame(
  at: number,
  sessionId: string,
  uuid: string,
  fields: {
    userMessageUuids: string[]
    durationMs: number
    numTurns: number
    subtype?: string
    isError?: boolean
    terminalReason?: string
  }
): CapturedFoldFrame {
  return {
    at,
    frame: {
      type: 'result',
      subtype: fields.subtype ?? 'success',
      session_id: sessionId,
      uuid,
      is_error: fields.isError ?? false,
      terminal_reason: fields.terminalReason ?? 'completed',
      duration_ms: fields.durationMs,
      num_turns: fields.numTurns,
      result: 'FIRST DONE',
      ...(fields.userMessageUuids.length > 0
        ? {
            user_message_uuid: fields.userMessageUuids[0],
            user_message_uuids: fields.userMessageUuids
          }
        : {})
    }
  }
}

export function sessionIdle(at: number, sessionId: string): CapturedFoldFrame {
  return {
    at,
    frame: {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      session_id: sessionId,
      uuid: `ssc-idle-${at}`
    }
  }
}

/** Root init marks each request cycle, including background wakes and manual compaction (p3 captures). */
export function initFrame(at: number, sessionId: string): CapturedFoldFrame {
  return {
    at,
    frame: {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      uuid: `init-${at}`,
      model: 'claude-sonnet-5',
      apiKeySource: 'none'
    }
  }
}

export function taskFrame(
  at: number,
  sessionId: string,
  subtype: string,
  fields: Record<string, unknown>
): CapturedFoldFrame {
  return {
    at,
    frame: { type: 'system', subtype, session_id: sessionId, uuid: `${subtype}-${at}`, ...fields }
  }
}
