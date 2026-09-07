import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'

export type LegacyWorkerReadResult = {
  dispatchId: string
  terminal: RuntimeTerminalRead
}

export type WorkerStartReceipt = {
  taskId: string
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
  warning?: string
  effects?: unknown[]
  residualResources?: unknown[]
  nextCommands?: string[]
}

export function formatWorkerStart(value: WorkerStartReceipt): string {
  const lines = [`Worker ${value.dispatchId} [${value.state}] for ${value.taskId}`]
  if (value.lastError) {
    lines.push(`${value.failedStage ?? 'start'}: ${value.lastError}`)
  } else if (value.warning) {
    lines.push(`Warning: ${value.warning}`)
  }
  if (value.state !== 'ready' && (value.state === 'outcome_unknown' || value.effects?.length)) {
    lines.push(`Effects: ${JSON.stringify(value.effects ?? [])}`)
  }
  if (
    value.state !== 'ready' &&
    (value.state === 'outcome_unknown' || value.residualResources?.length)
  ) {
    lines.push(`Residual resources: ${JSON.stringify(value.residualResources ?? [])}`)
  }
  if (value.state !== 'ready') {
    lines.push(...(value.nextCommands ?? []).map((command) => `Next command: ${command}`))
  }
  return lines.join('\n')
}

export function formatWorkerRead(
  value: OrchestrationWorkerReadResult | LegacyWorkerReadResult
): string {
  if (!('source' in value)) {
    return value.terminal.tail.join('\n')
  }
  const details = formatWorkerReadDetails(value)
  const output =
    value.source === 'terminal'
      ? value.terminal.tail.join('\n')
      : value.transcript.messages.map(formatWorkerTranscriptMessage).join('\n\n')
  if (output) {
    return `${details}\n\n${output}`
  }
  const emptyMessage =
    value.source === 'transcript'
      ? 'No transcript messages returned. This exact transcript read did not request terminal evidence.'
      : 'No terminal output returned.'
  return `${details}\n\n${emptyMessage}`
}

function formatWorkerReadDetails(value: OrchestrationWorkerReadResult): string {
  const source =
    value.source === 'transcript'
      ? `Source: transcript (provider=${value.provider})`
      : 'Source: terminal'
  const lines = [source]
  // A released archive read otherwise prints identically to a live one.
  if (value.status?.worker) {
    lines.push(`Worker: ${value.status.worker}`)
  }
  lines.push(`Archived: ${value.archived === true}`)
  // Two different verdicts: status.liveness is the PTY's, the fleet projection is the agent's.
  if (value.status?.liveness) {
    lines.push(`Terminal liveness: ${value.status.liveness}`)
  }
  if (value.projection) {
    lines.push(`Agent liveness: ${value.projection.liveness.verdict}`)
  }
  if (value.sourceExact !== undefined) {
    lines.push(`Source exact: ${value.sourceExact}`)
  }
  if (value.fallbackReason) {
    lines.push(`Fallback reason: ${value.fallbackReason}`)
  }
  if (value.contentComplete !== undefined) {
    lines.push(`Content complete: ${value.contentComplete}`)
  }
  if (value.clipping?.length) {
    lines.push(`Clipping: ${value.clipping.join(', ')}`)
  }
  lines.push(
    value.cursor
      ? `Continuation cursor (opaque; pass unchanged to --cursor): ${value.cursor}`
      : 'Continuation cursor: unavailable'
  )
  lines.push(...(value.warnings ?? []).map((warning) => `Warning: ${warning}`))
  return lines.join('\n')
}

function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  const blocks = message.blocks.map((block) => {
    if (block.type === 'text') {
      return block.text
    }
    if (block.type === 'tool-call') {
      return `[tool ${block.name}] ${safeJson(block.input)}`
    }
    if (block.type === 'tool-result') {
      return `[tool result${block.isError ? ' error' : ''}] ${block.output}`
    }
    return block.url ? `[image] ${block.url}` : `[image omitted]`
  })
  return `[${message.role}] ${blocks.join('\n')}`.trimEnd()
}

export type WorkerReleaseReceipt = {
  dispatchId: string
  state: string
  reason?: string
  processAction: string
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

export function formatWorkerRelease(value: WorkerReleaseReceipt): string {
  const head = `Worker ${value.dispatchId} terminal [${value.state}]`
  const lines = [
    `${head}${value.reason ? ` reason=${value.reason}` : ''} process=${value.processAction}`
  ]
  if (value.archive) {
    lines.push(`archive ${value.archive.source ?? 'none'} [${value.archive.status ?? 'unknown'}]`)
  }
  if (value.lastError) {
    lines.push(value.lastError)
  }
  if (value.recovery) {
    lines.push(value.recovery)
  }
  return lines.join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable input]'
  }
}
