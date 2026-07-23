import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

const DESKTOP_READ_WINDOW = 300

export const MAX_NATIVE_CHAT_DESKTOP_READ_LIMIT = 2_000
export const MAX_NATIVE_CHAT_SUBSCRIPTIONS_PER_SENDER = 64
export const MAX_NATIVE_CHAT_SUBSCRIPTIONS_PROCESS_WIDE = 256
export const MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PER_SENDER = 64
export const MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PROCESS_WIDE = 256
export const MAX_NATIVE_CHAT_READS_PER_SENDER = 8
export const MAX_NATIVE_CHAT_READS_PROCESS_WIDE = 16
export const MAX_NATIVE_CHAT_SUBSCRIPTION_ID_BYTES = 1_024
export const MAX_NATIVE_CHAT_SESSION_ID_BYTES = 4 * 1_024
export const MAX_NATIVE_CHAT_TRANSCRIPT_PATH_BYTES = 64 * 1_024
export const MAX_NATIVE_CHAT_AGENT_TYPE_BYTES = 64

function boundedString(
  value: unknown,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {}
): value is string {
  if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0)) {
    return false
  }
  return !measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
}

export function isValidNativeChatTranscriptRequestStrings(args: {
  agent: unknown
  sessionId: unknown
  transcriptPath?: unknown
}): boolean {
  return (
    boundedString(args.agent, MAX_NATIVE_CHAT_AGENT_TYPE_BYTES) &&
    boundedString(args.sessionId, MAX_NATIVE_CHAT_SESSION_ID_BYTES, { allowEmpty: true }) &&
    (args.transcriptPath === undefined ||
      boundedString(args.transcriptPath, MAX_NATIVE_CHAT_TRANSCRIPT_PATH_BYTES, {
        allowEmpty: true
      }))
  )
}

export function isValidNativeChatSubscriptionId(value: unknown): value is string {
  return boundedString(value, MAX_NATIVE_CHAT_SUBSCRIPTION_ID_BYTES)
}

export function normalizeNativeChatDesktopReadLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DESKTOP_READ_WINDOW
  }
  return Math.min(MAX_NATIVE_CHAT_DESKTOP_READ_LIMIT, Math.floor(limit))
}

class NativeChatAttemptAdmission {
  private readonly attempts = new Set<symbol>()
  private readonly attemptsBySender = new Map<number, Set<symbol>>()

  constructor(
    private readonly maxPerSender: number,
    private readonly maxProcessWide: number,
    private readonly tokenLabel: string
  ) {}

  claim(senderId: number): symbol | null {
    const senderAttempts = this.attemptsBySender.get(senderId)
    if (
      (senderAttempts?.size ?? 0) >= this.maxPerSender ||
      this.attempts.size >= this.maxProcessWide
    ) {
      return null
    }
    const token = Symbol(this.tokenLabel)
    const nextSenderAttempts = senderAttempts ?? new Set<symbol>()
    nextSenderAttempts.add(token)
    this.attemptsBySender.set(senderId, nextSenderAttempts)
    this.attempts.add(token)
    return token
  }

  release(senderId: number, token: symbol): void {
    this.attempts.delete(token)
    const senderAttempts = this.attemptsBySender.get(senderId)
    senderAttempts?.delete(token)
    if (senderAttempts?.size === 0) {
      this.attemptsBySender.delete(senderId)
    }
  }

  reset(): void {
    this.attempts.clear()
    this.attemptsBySender.clear()
  }

  get size(): number {
    return this.attempts.size
  }
}

export class NativeChatSetupAttemptAdmission extends NativeChatAttemptAdmission {
  constructor() {
    super(
      MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PER_SENDER,
      MAX_NATIVE_CHAT_SETUP_ATTEMPTS_PROCESS_WIDE,
      'native-chat-setup'
    )
  }
}

export class NativeChatReadAdmission extends NativeChatAttemptAdmission {
  constructor() {
    super(MAX_NATIVE_CHAT_READS_PER_SENDER, MAX_NATIVE_CHAT_READS_PROCESS_WIDE, 'native-chat-read')
  }
}
