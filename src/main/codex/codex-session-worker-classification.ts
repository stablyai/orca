import { open } from 'node:fs/promises'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../../shared/orca-dispatch-status-prompt'

const HEADER_BYTES = 1024 * 1024

export type InitialCodexPromptKind = 'worker' | 'other' | 'pending'

export async function classifyInitialCodexPrompt(
  filePath: string
): Promise<InitialCodexPromptKind> {
  const file = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return classifyCodexRolloutHeader(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await file.close()
  }
}

export function classifyCodexRolloutHeader(header: string): InitialCodexPromptKind {
  const lines = header.split('\n')
  if (!header.endsWith('\n')) {
    lines.pop()
  }
  let hasCodexMetadata = false
  for (const line of lines) {
    if (!line) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return hasCodexMetadata ? 'pending' : 'other'
    }
    if (!isRecord(record)) {
      continue
    }
    const payload = isRecord(record.payload) ? record.payload : null
    if (record.type === 'session_meta') {
      hasCodexMetadata = typeof payload?.id === 'string'
      continue
    }
    if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') {
      continue
    }
    const content = Array.isArray(payload.content) ? payload.content : []
    const texts = content.filter(isInputText).map((part) => part.text)
    if (texts.every(isInjectedContext)) {
      continue
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
  return hasCodexMetadata ? 'pending' : 'other'
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
