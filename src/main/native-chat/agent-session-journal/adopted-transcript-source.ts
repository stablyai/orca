import { dirname, join } from 'node:path'
import { sessionIdFromFileName } from '../../ai-vault/session-scanner-accumulator'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { readNodeFileWithinLimit } from '../../../shared/node-bounded-file-reader'
import { asRecord, extractString } from '../../ai-vault/session-scanner-values'
import { readOpenCodeTranscriptSignalViaWorker } from '../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import { samePiDirectory } from '../../pi/rpc-launch-resolution'
import { admitTranscriptPath } from '../transcript-path-admission'
import { adoptedDirectoryProbes } from './adopted-directory-probe'
import type { AdoptedTranscriptObservation } from './adopted-transcript-observation'

export type AdoptedTranscriptSource = {
  providerSessionId: string
  workspaceCwd: string
  /** Host-selected account store, never supplied by a wire caller or persisted. */
  conversationStore?: string
}

export async function assertAdoptedSourceIdentity(
  source: AdoptedTranscriptSource,
  actual: { sessionId: string | null; cwd: string | null },
  requireCwd = true,
  signal?: AbortSignal,
  agent?: AgentType
): Promise<void> {
  if (actual.sessionId !== source.providerSessionId) {
    throw new Error('The saved conversation does not match the requested provider identity.')
  }
  if (!requireCwd) {
    return
  }
  if (!actual.cwd) {
    throw new Error('This conversation belongs to another directory.')
  }
  if (
    normalizeRuntimePathForComparison(actual.cwd.trim()) ===
    normalizeRuntimePathForComparison(source.workspaceCwd.trim())
  ) {
    return
  }
  const matched =
    agent === 'pi'
      ? await samePiDirectory(actual.cwd, source.workspaceCwd)
      : await adoptedDirectoryProbes.matches(source.workspaceCwd, actual.cwd, signal)
  if (!matched) {
    throw new Error('This conversation belongs to another directory.')
  }
}

// Run on the owning host so directory probes retain their cancellation and child ownership.
export async function validateAdoptedTranscriptSource(input: {
  agent: AgentType
  filePath: string
  source: AdoptedTranscriptSource
  maxSourceBytes: number
  signal?: AbortSignal
  observed: AdoptedTranscriptObservation
}): Promise<void> {
  const observed = { ...input.observed }
  if (input.agent === 'grok') {
    const summaryPath = join(dirname(input.filePath), 'summary.json')
    if (!(await admitTranscriptPath(dirname(input.filePath), summaryPath))) {
      throw new Error('The conversation summary is outside its storage directory.')
    }
    const { buffer } = await readNodeFileWithinLimit(summaryPath, input.maxSourceBytes, {
      regularFileOnly: true
    })
    const summary = asRecord(asRecord(JSON.parse(buffer.toString('utf8')))?.info)
    observed.sessionId =
      extractString(summary?.id) ?? sessionIdFromFileName(dirname(input.filePath))
    observed.cwd = extractString(summary?.cwd)
  }
  if (input.agent === 'pi' && sessionIdFromFileName(input.filePath) !== observed.sessionId) {
    throw new Error('The saved conversation header does not match its file identity.')
  }
  await assertAdoptedSourceIdentity(
    input.source,
    observed,
    input.agent !== 'codex',
    input.signal,
    input.agent
  )
}

export async function validateAdoptedOpenCodeSource(
  dbPath: string,
  source: AdoptedTranscriptSource,
  signal?: AbortSignal
): Promise<void> {
  const metadata = await readOpenCodeTranscriptSignalViaWorker(
    {
      dbPath,
      sessionId: source.providerSessionId
    },
    signal
  )
  await assertAdoptedSourceIdentity(
    source,
    {
      sessionId: metadata ? source.providerSessionId : null,
      cwd: metadata?.cwd ?? null
    },
    true,
    signal
  )
}
