import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type CodexControlledTurnRecord = {
  operationId: string
  clientMessageId: string
  prompt: string
  phase: 'prepared' | 'accepted' | 'ambiguous' | 'finalized' | 'rejected'
  codexTurnId: string | null
}

type CodexControlledSessionState = {
  version: 1
  conversationId: string
  threadId: string
  accountId: string | null
  launchFingerprint: string
  turns: Record<string, CodexControlledTurnRecord>
}

export class CodexControlledSessionStateStore {
  constructor(
    private readonly filePath: string,
    private readonly identity: {
      conversationId: string
      threadId: string
      accountId: string | null
      launchFingerprint: string
    }
  ) {}

  get(idempotencyKey: string): CodexControlledTurnRecord | null {
    return this.read().turns[idempotencyKey] ?? null
  }

  put(idempotencyKey: string, record: CodexControlledTurnRecord): void {
    const state = this.read()
    state.turns[idempotencyKey] = record
    this.write(state)
  }

  private read(): CodexControlledSessionState {
    if (!existsSync(this.filePath)) {
      return { version: 1, ...this.identity, turns: {} }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      throw new Error('controlled Codex session state is unreadable')
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.conversationId !== this.identity.conversationId ||
      parsed.threadId !== this.identity.threadId ||
      parsed.accountId !== this.identity.accountId ||
      parsed.launchFingerprint !== this.identity.launchFingerprint
    ) {
      throw new Error('controlled Codex session state identity mismatch')
    }
    if (!isRecord(parsed.turns) || !Object.values(parsed.turns).every(isControlledTurnRecord)) {
      throw new Error('controlled Codex session state is unreadable')
    }
    return parsed as CodexControlledSessionState
  }

  private write(state: CodexControlledSessionState): void {
    const parent = dirname(this.filePath)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    chmodSync(parent, 0o700)
    const temporary = join(parent, `.${process.pid}.${Date.now()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.filePath)
    chmodSync(this.filePath, 0o600)
  }
}

function isControlledTurnRecord(value: unknown): value is CodexControlledTurnRecord {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.clientMessageId === 'string' &&
    typeof value.prompt === 'string' &&
    ['prepared', 'accepted', 'ambiguous', 'finalized', 'rejected'].includes(String(value.phase)) &&
    (value.codexTurnId === null || typeof value.codexTurnId === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
