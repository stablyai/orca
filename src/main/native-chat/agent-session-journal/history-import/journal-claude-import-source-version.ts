import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ClaudeImportResourceError,
  type ClaudeImportGrowth
} from './journal-claude-import-resource-error'

const QUIET_INTERVAL_MS = 40

export function changed(): never {
  throw new ClaudeImportResourceError('Claude transcript changed during history import.')
}

export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
}

export function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

export type ClaudeSourceCheckpoint = {
  size: bigint
  device: bigint
  inode: bigint
  digest: string
}

export type ClaudeSourceVersion = ClaudeSourceCheckpoint & {
  path: string
  modified: bigint
  changed: bigint
}

export function validRestage(
  current: BigIntStats,
  { prefix, minimumSize }: ClaudeImportGrowth
): boolean {
  return (
    current.isFile() &&
    current.dev === prefix.device &&
    current.ino === prefix.inode &&
    current.size > prefix.size &&
    current.size >= minimumSize
  )
}

export async function waitForClaudeImportQuiet(
  path: string,
  growth: ClaudeImportGrowth,
  signal?: AbortSignal
): Promise<ClaudeImportGrowth> {
  let before = await stat(path, { bigint: true }).catch(changed)
  if (!validRestage(before, growth)) {
    changed()
  }
  for (let interval = 0; interval < 3; interval++) {
    await delay(QUIET_INTERVAL_MS, undefined, { signal })
    const after = await stat(path, { bigint: true }).catch(changed)
    if (!validRestage(after, growth) || after.size < before.size) {
      changed()
    }
    if (sameVersion(before, after)) {
      return { ...growth, minimumSize: after.size }
    }
    before = after
  }
  changed()
}
