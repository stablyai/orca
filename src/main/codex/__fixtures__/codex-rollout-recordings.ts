import { readFile } from 'node:fs/promises'

export type RecordedCodexRecord = {
  type: string
  timestamp?: string
  ordinal?: number
  payload: Record<string, unknown>
}

export async function recordedCodexRollout(
  label: 'a' | 'b' | 'c' | 'r24'
): Promise<RecordedCodexRecord[]> {
  const version = label === 'r24' ? '0.166.0' : '0.162.1'
  const text = await readFile(
    new URL(`./codex-rollout-${label}-${version}.jsonl`, import.meta.url),
    'utf8'
  )
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}
