export type Role = 'user' | 'assistant'

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export type ToolUse = {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  text?: string
  isError?: boolean
}

/** A tool_result block of a user message. */
export type ToolResult = {
  tool_use_id: string
  text: string
  isError?: boolean
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export type Message = {
  role: Role
  text: string
  toolUses: ToolUse[]
  toolResults?: ToolResult[]
}

/** A tool call paired with its result by `tool_use_id`. */
export type ToolCall = {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  /** Index of the message holding the tool_use block. */
  callIndex: number
  /** Index of the message holding the tool_result block. */
  resultIndex: number
  resultChars: number
  isError: boolean
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean
}

export type CallAnswer = {
  /** Jev's probability that the call itself still matters. */
  keepCall: number
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call'

export type CallDecision = {
  id: string
  tool: string
  action: CallAction
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped'
} & CallAnswer

export type HistoryToolCall = {
  id: string
  tool: string
  input: string
  result: string
}

export type HistoryEntry = {
  i: number
  role: Role
  text: string
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[]
}

/** The state sent with every Jev request: the whole history, results omitted. */
export type CompactionState = {
  context: string
  goal: string
  history: HistoryEntry[]
}

export type FittedState = {
  state: CompactionState
  tokens: number
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string
}

export type CompactOptions = {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number
}

export type ResolvedCompactOptions = {
  goal: string
  keepThreshold: number
  preserveRecentMessages: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
}

export type CompactResult = {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[]
  decisions: CallDecision[]
  stats: {
    messagesBefore: number
    messagesAfter: number
    charsBefore: number
    charsAfter: number
    calls: number
    kept: number
    resultsDropped: number
    callsDropped: number
    pinned: number
    stateTokens: number
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string
    requests: number
    ms: number
  }
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object

export type NoulQuestion = {
  type: 'noul'
  instructions: string
  criteria?: {
    true?: string
    false?: string
  }
}

export type ChoiceQuestion = {
  type: 'choice'
  instructions: string
  criteria: Record<string, string | null>
}

export type ScoreQuestion = {
  type: 'score'
  instructions: string
  criteria: string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
export type JevQuestions = Record<string, JevQuestion>

export type NoulAnswer = {
  type?: 'noul'
  noul: number
}

export type ChoiceAnswer = {
  type?: 'choice'
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export type ScoreAnswer = {
  type?: 'score'
  score: number
  confidence: number
  probabilities: Record<string, number>
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type JevResponse = {
  model?: string
  answers: Record<string, JevAnswer>
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
  [key: string]: unknown
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export type JevAsker = {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>
}
