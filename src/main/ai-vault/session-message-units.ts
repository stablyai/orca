import type { AiVaultSessionMessageRole } from '../../shared/ai-vault-session-message-hit'
import { collectTranscriptScopeTexts } from '../../shared/ai-vault-session-transcript-scope'
import { readableAiVaultSessionTargets } from './session-message-fts-access'
import { iterateAiVaultTranscriptLines } from './session-message-transcript-lines'

export const AI_VAULT_SESSION_MESSAGE_INDEX_MAX_UNITS = 2_000

export type AiVaultSessionMessageUnit = {
  seq: number
  role: AiVaultSessionMessageRole
  text: string
  filePath: string
  byteOffset: number
  lineNumber: number
}

export type AiVaultSessionMessageExtractResult =
  | { ok: true; units: AiVaultSessionMessageUnit[] }
  | { ok: false }

export async function extractAiVaultSessionMessageUnits(session: {
  agent: string
  filePath: string
}): Promise<AiVaultSessionMessageExtractResult> {
  const units: AiVaultSessionMessageUnit[] = []
  try {
    for (const filePath of await readableAiVaultSessionTargets(session)) {
      for await (const line of iterateAiVaultTranscriptLines(filePath)) {
        appendUnitsFromTranscriptLine(line.text, filePath, line.byteOffset, line.lineNumber, units)
        if (units.length >= AI_VAULT_SESSION_MESSAGE_INDEX_MAX_UNITS) {
          return { ok: true, units }
        }
      }
    }
    return { ok: true, units }
  } catch {
    // Why: a mid-read failure is not an empty transcript; leave the session
    // unindexed so search can still fall back to rg.
    return { ok: false }
  }
}

function appendUnitsFromTranscriptLine(
  line: string,
  filePath: string,
  byteOffset: number,
  lineNumber: number,
  units: AiVaultSessionMessageUnit[]
): void {
  const trimmed = line.trim()
  if (!trimmed) {
    return
  }
  let record: unknown = trimmed
  try {
    record = JSON.parse(trimmed) as unknown
  } catch {
    pushUnit(units, 'user', trimmed, filePath, byteOffset, lineNumber)
    return
  }
  const texts = collectTranscriptScopeTexts(record)
  pushUnit(units, 'user', texts.user, filePath, byteOffset, lineNumber)
  pushUnit(units, 'assistant', texts.assistant, filePath, byteOffset, lineNumber)
  pushUnit(units, 'tool', texts.tool, filePath, byteOffset, lineNumber)
  pushUnit(units, 'error', texts.error, filePath, byteOffset, lineNumber)
}

function pushUnit(
  units: AiVaultSessionMessageUnit[],
  role: AiVaultSessionMessageRole,
  text: string,
  filePath: string,
  byteOffset: number,
  lineNumber: number
): void {
  const trimmed = text.trim()
  if (!trimmed || units.length >= AI_VAULT_SESSION_MESSAGE_INDEX_MAX_UNITS) {
    return
  }
  units.push({
    seq: units.length,
    role,
    text: trimmed.slice(0, 8_000),
    filePath,
    byteOffset,
    lineNumber
  })
}
