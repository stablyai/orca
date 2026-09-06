import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { formatWorkerTranscriptMessage } from '../../../shared/worker-transcript-text'

export type LegacyWorkerReadResult = {
  dispatchId: string
  terminal: RuntimeTerminalRead
}

export function formatWorkerRead(
  value: OrchestrationWorkerReadResult | LegacyWorkerReadResult
): string {
  if (!('source' in value) || value.source === 'terminal') {
    return value.terminal.tail.join('\n')
  }
  return value.transcript.messages.map(formatWorkerTranscriptMessage).join('\n\n')
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
