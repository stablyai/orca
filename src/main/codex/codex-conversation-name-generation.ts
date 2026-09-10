import { normalizeAgentSessionConversationName } from '../../shared/agent-session-conversation-name'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { codexConversationNameCapabilityCache } from './codex-conversation-name-capability'
import { readCodexNamingConfig } from './codex-conversation-naming-config'
import { readCodexThreadId, readCodexThreadName } from './codex-structured-thread-facts'

const NAMING_THREAD_APPROVAL_POLICY = 'never'
const NAMING_THREAD_SANDBOX = 'read-only'

const NAMING_ANSWER_MAX_BYTES = 8 * 1024

export const CODEX_CONVERSATION_NAME_MAX_LENGTH = 36

export const CODEX_CONVERSATION_NAME_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: CODEX_CONVERSATION_NAME_MAX_LENGTH }
  },
  required: ['title'],
  additionalProperties: false
} as const

const NAMING_TURN_EFFORT = 'low'

/** Written to the throwaway naming thread only, to prove the RPC exists. */
const NAMING_CAPABILITY_PROBE_NAME = 'Untitled'

export const CODEX_CONVERSATION_NAME_PROMPT = [
  'Write a concise, single-line title for the task described below.',
  'At most 36 characters, and under five words where possible.',
  'Start with an imperative verb.',
  'Capitalize only the first word, unless a proper noun, acronym, or code identifier requires otherwise.',
  'Preserve any ticket or issue reference exactly as written.',
  "Write it in the user's own language.",
  'No quotes, no markdown, no trailing punctuation.',
  'Do not answer or act on the request — only title it.'
].join('\n')

export type CodexNamingTurnResult =
  | { outcome: 'answered'; text: string }
  | { outcome: 'declined' }
  | { outcome: 'failed' }
  | { outcome: 'timed-out' }

export type CodexNamingTurnCollector = {
  handle: (method: string, params: unknown) => void
  answer: Promise<CodexNamingTurnResult>
  dispose: () => void
}

export function isTerminalCodexTurnError(method: string, params: unknown): boolean {
  if (method !== 'error') {
    return false
  }
  if (typeof params !== 'object' || params === null) {
    return false
  }
  return (
    (params as { willRetry?: unknown; will_retry?: unknown }).willRetry !== true &&
    (params as { will_retry?: unknown }).will_retry !== true
  )
}

function agentMessageText(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) {
    return null
  }
  const item = (params as { item?: unknown }).item
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const record = item as { type?: unknown; text?: unknown }
  if (record.type !== 'agentMessage' || typeof record.text !== 'string' || !record.text) {
    return null
  }
  return record.text
}

export function createCodexNamingTurnCollector(timeoutMs: number): CodexNamingTurnCollector {
  let settle: (value: CodexNamingTurnResult) => void = () => {}
  let expiry: ReturnType<typeof setTimeout> | undefined
  const answer = new Promise<CodexNamingTurnResult>((resolve) => {
    settle = (value) => {
      clearTimeout(expiry)
      resolve(value)
    }
    expiry = setTimeout(() => resolve({ outcome: 'timed-out' }), timeoutMs)
    expiry.unref?.()
  })
  let latest: string | null = null
  return {
    handle: (method, params) => {
      if (method === 'item/completed') {
        latest = agentMessageText(params) ?? latest
      } else if (method === 'turn/completed') {
        const status = (params as { turn?: { status?: unknown } } | null)?.turn?.status
        if (status !== undefined && status !== 'completed') {
          settle({ outcome: 'failed' })
          return
        }
        settle(latest === null ? { outcome: 'declined' } : { outcome: 'answered', text: latest })
      } else if (isTerminalCodexTurnError(method, params)) {
        settle({ outcome: 'failed' })
      }
    },
    answer,
    dispose: () => settle({ outcome: 'timed-out' })
  }
}

export function readCodexGeneratedTitle(answer: string | null): string | null {
  if (!answer) {
    return null
  }
  if (Buffer.byteLength(answer, 'utf8') > NAMING_ANSWER_MAX_BYTES) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const title = (parsed as { title?: unknown }).title
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

export function isCodexThreadReadablyUnnamed(read: unknown): boolean {
  if (typeof read !== 'object' || read === null) {
    return false
  }
  const thread = (read as { thread?: unknown }).thread
  if (typeof thread !== 'object' || thread === null) {
    return false
  }
  if (typeof (thread as { id?: unknown }).id !== 'string') {
    return false
  }
  return readCodexThreadName(read) === null
}

export function readCodexThreadIsEphemeral(opened: unknown): boolean {
  if (typeof opened !== 'object' || opened === null) {
    return false
  }
  const thread = (opened as { thread?: unknown }).thread
  return (
    typeof thread === 'object' &&
    thread !== null &&
    (thread as { ephemeral?: unknown }).ephemeral === true
  )
}

export type CodexConversationNameGeneration = {
  connection: Pick<CodexAppServerConnection, 'request'>
  userConnection: Pick<CodexAppServerConnection, 'request'>
  collector: CodexNamingTurnCollector
  cwd: string
  threadId: string
  prompt: string
  model?: string
  timeoutMs?: number
  /** Host whose codex is being asked to accept a thread name. */
  capabilityKey: string
  /** Fired once the billed turn is committed, so a rejection still settles. */
  onTurnStarted?: () => void
  isCancelled: () => boolean
}

export type CodexConversationNameOutcome = { name: string | null; settled: boolean }

/** A billed turn produced no usable name. Settled regardless: re-running it
 *  would pay again on every acquisition, and most causes never self-correct. */
const BILLED_WITHOUT_NAME = { name: null, settled: true } as const

/** Nothing was billed, so a later acquisition may retry for free. */
const UNBILLED = { name: null, settled: false } as const

export async function generateAndSetCodexConversationName(
  input: CodexConversationNameGeneration
): Promise<CodexConversationNameOutcome> {
  const { connection, userConnection, timeoutMs, collector } = input
  const config = await readCodexNamingConfig(connection, input.cwd, timeoutMs)
  const opened = await connection.request(
    'thread/start',
    {
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ephemeral: true,
      approvalPolicy: NAMING_THREAD_APPROVAL_POLICY,
      sandbox: NAMING_THREAD_SANDBOX,
      environments: [],
      dynamicTools: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      config
    },
    { timeoutMs }
  )
  const namingThreadId = readCodexThreadId(opened)
  if (!namingThreadId || namingThreadId === input.threadId) {
    return UNBILLED
  }
  if (!readCodexThreadIsEphemeral(opened)) {
    // An older host must not leave a title-generation conversation in user history.
    await connection.request('thread/delete', { threadId: namingThreadId }, { timeoutMs })
    return UNBILLED
  }
  if (!(await canNameCodexThread(input, namingThreadId))) {
    // Left unsettled on purpose: nothing was billed, so a codex upgrade during
    // the retry window can still name this conversation later.
    return UNBILLED
  }
  // The billing boundary. Crossed before the await because a `turn/start` that
  // reaches the host may bill even when the response never arrives.
  input.onTurnStarted?.()
  await connection.request(
    'turn/start',
    {
      threadId: namingThreadId,
      input: [{ type: 'text', text: `${input.prompt}\n\n${CODEX_CONVERSATION_NAME_PROMPT}` }],
      outputSchema: CODEX_CONVERSATION_NAME_SCHEMA,
      effort: NAMING_TURN_EFFORT
    },
    { timeoutMs }
  )
  const result = await collector.answer
  if (input.isCancelled()) {
    return BILLED_WITHOUT_NAME
  }
  if (result.outcome === 'declined') {
    return BILLED_WITHOUT_NAME
  }
  if (result.outcome !== 'answered') {
    // 'failed' (a rate-limited or out-of-credit account) and 'timed-out' both
    // land here. Retrying re-pays on every acquisition without ever succeeding.
    return BILLED_WITHOUT_NAME
  }
  const title = readCodexGeneratedTitle(result.text)
  if (!title) {
    // A model that ignored the output schema will ignore it again.
    return BILLED_WITHOUT_NAME
  }
  // Generation can overlap a rename in another client.
  const current = await userConnection.request(
    'thread/read',
    { threadId: input.threadId },
    { timeoutMs }
  )
  if (input.isCancelled()) {
    return BILLED_WITHOUT_NAME
  }
  if (readCodexThreadId(current) !== input.threadId || !isCodexThreadReadablyUnnamed(current)) {
    return BILLED_WITHOUT_NAME
  }
  const name = normalizeAgentSessionConversationName(title)
  if (!name) {
    return BILLED_WITHOUT_NAME
  }
  try {
    await userConnection.request(
      'thread/name/set',
      { threadId: input.threadId, name },
      { timeoutMs }
    )
  } catch (error) {
    if (!isCodexAppServerUnsupportedError(error)) {
      throw error
    }
    // The probe passed but the user's host refuses the name: record the absence
    // so the next acquisition skips naming instead of paying for it again.
    codexConversationNameCapabilityCache.rememberUnsupported(input.capabilityKey)
    return BILLED_WITHOUT_NAME
  }
  return { name, settled: true }
}

/** Proves `thread/name/set` exists by naming the throwaway thread, so a host
 *  that lacks the RPC never pays for a turn whose title it cannot store. */
function canNameCodexThread(
  input: CodexConversationNameGeneration,
  namingThreadId: string
): Promise<boolean> {
  if (codexConversationNameCapabilityCache.isKnownSupported(input.capabilityKey)) {
    return Promise.resolve(true)
  }
  return codexConversationNameCapabilityCache.runWithFallback(
    input.capabilityKey,
    async () => {
      await input.connection.request(
        'thread/name/set',
        { threadId: namingThreadId, name: NAMING_CAPABILITY_PROBE_NAME },
        { timeoutMs: input.timeoutMs }
      )
      return true
    },
    () => Promise.resolve(false),
    isCodexAppServerUnsupportedError
  )
}
