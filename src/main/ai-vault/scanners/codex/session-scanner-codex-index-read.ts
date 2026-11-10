import type { Stats } from 'node:fs'
import { readSessionIndexJsonl, type SessionIndexJsonlRead } from '../../session-index-jsonl-read'
import { extractString, parseJsonObject } from '../../session-scanner-values'
import { normalizeTitleText } from '../../session-scanner-text-normalization'

export type CodexIndexRead = SessionIndexJsonlRead & { titles: Map<string, string> }
export async function readCodexIndexUpdate(
  path: string,
  stat: Stats,
  previous?: CodexIndexRead
): Promise<CodexIndexRead> {
  const read = await readSessionIndexJsonl(path, stat, previous, parseCodexTitleIndexRecord)
  return { ...read, titles: read.values }
}
export function parseCodexTitleIndexRecord(line: string): readonly [string, string] | null {
  const record = parseJsonObject(line)
  const id = record && extractString(record.id)
  const title = record && normalizeTitleText(extractString(record.thread_name) ?? '')
  return id && title ? [id, title] : null
}
