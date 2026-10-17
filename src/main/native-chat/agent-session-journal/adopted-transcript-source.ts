import { dirname, join } from 'node:path'
import { sessionIdFromFileName } from '../../ai-vault/session-scanner-accumulator'
import type { AgentType } from '../../../shared/agent-status-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { readNodeFileWithinLimit } from '../../../shared/node-bounded-file-reader'
import { asRecord, extractString, parseJsonObject } from '../../ai-vault/session-scanner-values'
import { readOpenCodeTranscriptSignalViaWorker } from '../../ai-vault/session-scanner-opencode-sqlite-worker-spawn'
import { samePiDirectory } from '../../pi/rpc-launch-resolution'
import { admitTranscriptPath } from '../transcript-path-admission'

export type AdoptedTranscriptSource = { providerSessionId: string; workspaceCwd: string }

export function assertAdoptedSourceIdentity(
  source: AdoptedTranscriptSource,
  actual: { sessionId: string | null; cwd: string | null },
  requireCwd = true
): void {
  if (actual.sessionId !== source.providerSessionId) {
    throw new Error('The saved conversation does not match the requested provider identity.')
  }
  if (
    requireCwd &&
    (!actual.cwd ||
      normalizeRuntimePathForComparison(actual.cwd.trim()) !==
        normalizeRuntimePathForComparison(source.workspaceCwd.trim()))
  ) {
    throw new Error('This conversation belongs to another directory.')
  }
}

/** Metadata is observed from the same lines that become the imported journal. */
export function adoptedTranscriptSourceObserver(input: {
  agent: AgentType
  filePath: string
  source: AdoptedTranscriptSource
  maxSourceBytes: number
}) {
  let sessionId: string | null =
    input.agent === 'claude' || input.agent === 'codex'
      ? sessionIdFromFileName(input.filePath)
      : null
  let cwd: string | null = null
  let sawCodexMetadata = false
  return {
    observe(line: string) {
      const record = parseJsonObject(line)
      if (!record) {
        return
      }
      if (input.agent === 'claude') {
        sessionId = extractString(record.sessionId) ?? sessionId
        cwd ??= extractString(record.cwd)
      } else if (input.agent === 'codex' && record.type === 'session_meta' && !sawCodexMetadata) {
        sawCodexMetadata = true
        const payload = asRecord(record.payload)
        sessionId = extractString(payload?.id) ?? sessionId
      } else if ((input.agent === 'omp' || input.agent === 'pi') && record.type === 'session') {
        sessionId = extractString(record.id)
        cwd = extractString(record.cwd)
      }
    },
    async validate() {
      if (input.agent === 'grok') {
        const summaryPath = join(dirname(input.filePath), 'summary.json')
        if (!(await admitTranscriptPath(dirname(input.filePath), summaryPath))) {
          throw new Error('The conversation summary is outside its storage directory.')
        }
        const { buffer } = await readNodeFileWithinLimit(summaryPath, input.maxSourceBytes, {
          regularFileOnly: true
        })
        const summary = asRecord(asRecord(JSON.parse(buffer.toString('utf8')))?.info)
        sessionId = extractString(summary?.id) ?? sessionIdFromFileName(dirname(input.filePath))
        cwd = extractString(summary?.cwd)
      }
      if (input.agent === 'pi' && sessionIdFromFileName(input.filePath) !== sessionId) {
        throw new Error('The saved conversation header does not match its file identity.')
      }
      if (input.agent === 'pi' && cwd && (await samePiDirectory(cwd, input.source.workspaceCwd))) {
        cwd = input.source.workspaceCwd
      }
      assertAdoptedSourceIdentity(input.source, { sessionId, cwd }, input.agent !== 'codex')
    }
  }
}

export async function validateAdoptedOpenCodeSource(
  dbPath: string,
  source: AdoptedTranscriptSource
): Promise<void> {
  const signal = await readOpenCodeTranscriptSignalViaWorker({
    dbPath,
    sessionId: source.providerSessionId
  })
  assertAdoptedSourceIdentity(source, {
    sessionId: signal ? source.providerSessionId : null,
    cwd: signal?.cwd ?? null
  })
}
