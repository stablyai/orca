import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../../shared/orca-dispatch-status-prompt'

export type InitialCodexPromptKind = 'worker' | 'other' | 'pending'

export async function classifyInitialCodexPrompt(
  filePath: string
): Promise<InitialCodexPromptKind> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const classifier = new CodexRolloutClassifier()
  try {
    for await (const line of lines) {
      const kind = classifier.accept(line)
      if (kind !== 'pending') {
        return kind
      }
    }
    return classifier.finish()
  } finally {
    lines.close()
    stream.destroy()
  }
}

export function classifyCodexRolloutHeader(header: string): InitialCodexPromptKind {
  const classifier = new CodexRolloutClassifier()
  const lines = header.split('\n')
  if (!header.endsWith('\n')) {
    lines.pop()
  }
  for (const line of lines) {
    const kind = classifier.accept(line)
    if (kind !== 'pending') {
      return kind
    }
  }
  return classifier.finish()
}

class CodexRolloutClassifier {
  private hasCodexMetadata = false

  accept(line: string): InitialCodexPromptKind {
    if (!line) {
      return 'pending'
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return this.finish()
    }
    if (!isRecord(record)) {
      return 'pending'
    }
    const payload = isRecord(record.payload) ? record.payload : null
    if (record.type === 'session_meta') {
      this.hasCodexMetadata = typeof payload?.id === 'string'
      return 'pending'
    }
    if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') {
      return 'pending'
    }
    const content = Array.isArray(payload.content) ? payload.content : []
    const texts = content.filter(isInputText).map((part) => part.text)
    if (texts.every(isInjectedContext)) {
      return 'pending'
    }
    const prompt = texts.join('\n')
    return prompt.startsWith(
      `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX} You are a dispatched worker.`
    ) &&
      /Your task ID is:\s*task_[a-z0-9]+/.test(prompt) &&
      /--dispatch-id\s+ctx_[a-z0-9]+/.test(prompt)
      ? 'worker'
      : 'other'
  }

  finish(): InitialCodexPromptKind {
    return this.hasCodexMetadata ? 'pending' : 'other'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInputText(value: unknown): value is { type: 'input_text'; text: string } {
  return isRecord(value) && value.type === 'input_text' && typeof value.text === 'string'
}

function isInjectedContext(text: string): boolean {
  return (
    text.startsWith('# AGENTS.md instructions for ') || text.startsWith('<environment_context>')
  )
}
