import { basename, dirname, resolve } from 'node:path'

/** Extensions accepted by Codex session discovery (plain + cold zstd). */
export const CODEX_SESSION_ROLLOUT_EXTENSIONS = ['.jsonl', '.zst'] as const

export function codexHomeForSessionsDir(
  sessionsDir: string,
  defaultCodexHomeDir: string
): string | null {
  const codexHome = dirname(sessionsDir)
  return codexHome === defaultCodexHomeDir ? null : codexHome
}

export function uniqueCodexSessionsDirs(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    const trimmed = path.trim()
    if (!trimmed) {
      continue
    }
    const key = resolve(trimmed)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

/** True for Codex rollout logs: `*.jsonl` or cold-compressed `*.jsonl.zst`. */
export function isCodexSessionRolloutFileName(fileName: string): boolean {
  return fileName.endsWith('.jsonl') || fileName.endsWith('.jsonl.zst')
}

export function isCodexSessionRolloutPath(filePath: string): boolean {
  return isCodexSessionRolloutFileName(basename(filePath))
}

/** True when the rollout was cold-compressed by Codex (`*.jsonl.zst`). */
export function isCodexCompressedRolloutPath(filePath: string): boolean {
  return filePath.endsWith('.jsonl.zst')
}

/** Basename without rollout suffixes so UUID extraction also works for cold sessions. */
export function codexRolloutBaseName(filePath: string): string {
  const name = basename(filePath)
  if (name.endsWith('.jsonl.zst')) {
    return name.slice(0, -'.jsonl.zst'.length)
  }
  if (name.endsWith('.jsonl')) {
    return name.slice(0, -'.jsonl'.length)
  }
  return name
}
