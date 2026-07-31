import { readFile } from 'node:fs/promises'
import { getProcessedFileInfo, listCodexSessionFiles } from '../codex-usage/scanner'

type CodexTokenCountInfo = {
  total_token_usage?: { total_tokens?: number }
  last_token_usage?: { total_tokens?: number }
  model_context_window?: number
}

function ensurePositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Extracts the used-percentage from the last `token_count` event in a Codex session log
 * (a rollout .jsonl file). Exported standalone so it can be unit tested with fixture
 * strings instead of real session files.
 */
export function extractCodexSessionUsedPercentFromLog(content: string): number | null {
  const lines = content.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) {
      continue
    }
    const { type, payload } = record as { type?: unknown; payload?: unknown }
    if (type !== 'event_msg' || typeof payload !== 'object' || payload === null) {
      continue
    }
    const { type: payloadType, info } = payload as { type?: unknown; info?: unknown }
    if (payloadType !== 'token_count' || typeof info !== 'object' || info === null) {
      continue
    }
    const typedInfo = info as CodexTokenCountInfo
    const contextWindow = ensurePositiveNumber(typedInfo.model_context_window)
    if (!contextWindow) {
      continue
    }
    const totalTokens =
      ensurePositiveNumber(typedInfo.total_token_usage?.total_tokens) ??
      ensurePositiveNumber(typedInfo.last_token_usage?.total_tokens)
    if (totalTokens === null) {
      continue
    }
    return Math.min(100, Math.max(0, (totalTokens / contextWindow) * 100))
  }
  return null
}

/**
 * Local, network-free fallback for Codex session usage: reads the most recently modified
 * session log and returns the used-percentage from its last token_count event. Unlike
 * Claude, Codex has no live per-turn push into Orca, so every usage refresh normally
 * depends on reaching chatgpt.com — this is the only signal left when that's unreachable
 * (e.g. on an internal network). Dependency-injected for testing without touching real fs.
 */
export async function readLatestCodexSessionUsedPercent(
  listFiles: () => Promise<string[]> = listCodexSessionFiles,
  statFile: (filePath: string) => Promise<{ mtimeMs: number }> = getProcessedFileInfo,
  readFileFn: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, 'utf8')
): Promise<number | null> {
  try {
    const files = await listFiles()
    const candidates: { path: string; mtimeMs: number }[] = []
    for (const filePath of files) {
      try {
        const info = await statFile(filePath)
        candidates.push({ path: filePath, mtimeMs: info.mtimeMs })
      } catch {
        // Missing/unreadable file — another session log may still qualify.
      }
    }
    // Why: the newest session log may not have a token_count event yet (e.g. just
    // created, no turns sent) — fall through to older logs rather than going dark.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { path } of candidates) {
      try {
        const content = await readFileFn(path)
        const usedPercent = extractCodexSessionUsedPercentFromLog(content)
        if (usedPercent !== null) {
          return usedPercent
        }
      } catch {
        // Unreadable file — try the next-newest candidate.
      }
    }
    return null
  } catch {
    return null
  }
}
