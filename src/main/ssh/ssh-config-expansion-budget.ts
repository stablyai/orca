import { statSync } from 'node:fs'
import { readNodeFileSyncWithinLimit } from '../../shared/memory-safety/node-bounded-file-reader'
import type { SshConfigTruncationReason } from '../../shared/ssh-types'

export type { SshConfigTruncationReason }

export const SSH_CONFIG_INCLUDE_LIMITS = {
  expandedBytes: 16 * 1024 * 1024,
  expandedLines: 200_000,
  fileBytes: 1024 * 1024,
  files: 1024,
  globMatches: 256,
  nestingDepth: 16,
  sourceBytes: 16 * 1024 * 1024
} as const

export type SshConfigExpansionBudget = {
  cache: Map<string, string>
  droppedReasons: Set<SshConfigTruncationReason>
  expandedBytes: number
  expandedLines: number
  fileCount: number
  outputTruncated: boolean
  sourceBytes: number
  warnedLimits: Set<string>
}

export function createSshConfigExpansionBudget(): SshConfigExpansionBudget {
  return {
    cache: new Map(),
    droppedReasons: new Set(),
    expandedBytes: 0,
    expandedLines: 0,
    fileCount: 0,
    outputTruncated: false,
    sourceBytes: 0,
    warnedLimits: new Set()
  }
}

/**
 * Reasons the expansion dropped configuration, or null when nothing was dropped.
 * Sorted so the value is stable to compare and assert against.
 */
export function getSshConfigTruncationReasons(
  budget: SshConfigExpansionBudget
): SshConfigTruncationReason[] | null {
  if (budget.droppedReasons.size === 0) {
    return null
  }
  return [...budget.droppedReasons].sort()
}

export function recordSshConfigDrop(
  budget: SshConfigExpansionBudget,
  reason: SshConfigTruncationReason
): void {
  budget.droppedReasons.add(reason)
}

export function admitSshConfigIncludeDepth(
  budget: SshConfigExpansionBudget,
  activeDepth: number
): boolean {
  if (activeDepth < SSH_CONFIG_INCLUDE_LIMITS.nestingDepth) {
    return true
  }
  warnOnce(
    budget,
    'nesting-depth',
    `[ssh] SSH config Include nesting exceeds ${SSH_CONFIG_INCLUDE_LIMITS.nestingDepth}; skipping deeper files`
  )
  return false
}

export function appendSshConfigExpandedLine(
  target: string[],
  line: string,
  budget: SshConfigExpansionBudget
): void {
  const nextBytes = Buffer.byteLength(line, 'utf8') + (target.length > 0 ? 1 : 0)
  if (
    budget.expandedLines >= SSH_CONFIG_INCLUDE_LIMITS.expandedLines ||
    budget.expandedBytes + nextBytes > SSH_CONFIG_INCLUDE_LIMITS.expandedBytes
  ) {
    budget.outputTruncated = true
    warnOnce(
      budget,
      'expanded-output',
      `[ssh] Expanded SSH config exceeds ${SSH_CONFIG_INCLUDE_LIMITS.expandedBytes} bytes or ${SSH_CONFIG_INCLUDE_LIMITS.expandedLines} lines; truncating`
    )
    return
  }
  target.push(line)
  budget.expandedBytes += nextBytes
  budget.expandedLines += 1
}

export function readSshConfigSourceFile(
  filePath: string,
  budget: SshConfigExpansionBudget
): string | null {
  const cached = budget.cache.get(filePath)
  if (cached !== undefined) {
    return cached
  }
  if (budget.fileCount >= SSH_CONFIG_INCLUDE_LIMITS.files) {
    warnOnce(
      budget,
      'file-count',
      `[ssh] SSH config Include file count exceeds ${SSH_CONFIG_INCLUDE_LIMITS.files}; skipping additional files`
    )
    return null
  }
  const fileBytes = getReadableRegularFileBytes(filePath, budget)
  if (fileBytes === null || !hasSourceCapacity(budget, fileBytes)) {
    return null
  }

  try {
    const content = readNodeFileSyncWithinLimit(
      filePath,
      SSH_CONFIG_INCLUDE_LIMITS.fileBytes
    ).buffer.toString('utf-8')
    const actualBytes = Buffer.byteLength(content, 'utf8')
    if (actualBytes > SSH_CONFIG_INCLUDE_LIMITS.fileBytes) {
      recordSshConfigDrop(budget, 'file-bytes')
      return null
    }
    if (!hasSourceCapacity(budget, actualBytes)) {
      return null
    }
    budget.cache.set(filePath, content)
    budget.fileCount += 1
    budget.sourceBytes += actualBytes
    return content
  } catch {
    return null
  }
}

function hasSourceCapacity(budget: SshConfigExpansionBudget, fileBytes: number): boolean {
  if (budget.sourceBytes + fileBytes <= SSH_CONFIG_INCLUDE_LIMITS.sourceBytes) {
    return true
  }
  warnOnce(
    budget,
    'source-bytes',
    `[ssh] SSH config Include sources exceed ${SSH_CONFIG_INCLUDE_LIMITS.sourceBytes} bytes; skipping additional files`
  )
  return false
}

function getReadableRegularFileBytes(
  filePath: string,
  budget: SshConfigExpansionBudget
): number | null {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      // Not a capacity drop: a non-regular include is skipped by OpenSSH too.
      console.warn(`[ssh] Skipping SSH config include "${filePath}": not a regular file`)
      return null
    }
    if (stats.size > SSH_CONFIG_INCLUDE_LIMITS.fileBytes) {
      recordSshConfigDrop(budget, 'file-bytes')
      console.warn(
        `[ssh] Skipping SSH config include "${filePath}": size ${stats.size} exceeds ${SSH_CONFIG_INCLUDE_LIMITS.fileBytes} bytes`
      )
      return null
    }
    return stats.size
  } catch {
    return null
  }
}

// Every ceiling that drops configuration reports through here, so recording the
// reason alongside the warning keeps the caller-visible set complete by construction.
function warnOnce(
  budget: SshConfigExpansionBudget,
  key: SshConfigTruncationReason,
  message: string
): void {
  recordSshConfigDrop(budget, key)
  if (budget.warnedLimits.has(key)) {
    return
  }
  budget.warnedLimits.add(key)
  console.warn(message)
}
