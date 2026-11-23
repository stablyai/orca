import { join } from 'node:path'
import { parseCodexRolloutThreadId } from '../rollouts/codex-rollout-thread-id'
import { readEntries } from './codex-history-store-names'

const SESSIONS = 'sessions'

// Codex files a rollout under its start date: `rollout-YYYY-MM-DDT...`.
export function datedFolderOf(name: string): string | null {
  const stamp = parseCodexRolloutThreadId(name)?.rolloutStamp
  const match = stamp ? /^(\d{4})-(\d{2})-(\d{2})T/.exec(stamp) : null
  return match ? join(SESSIONS, match[1], match[2], match[3]) : null
}

type DayFolderListing = {
  /** Newest first, relative to the home. */
  days: string[]
  /** False when a folder couldn't be read: its days wait for a later pass. */
  complete: boolean
}

/** Day folders under `sessions/`; an unreadable year or month skips only its own days. */
export async function listDayFolders(home: string): Promise<DayFolderListing> {
  let complete = true
  const childFolders = async (parts: string[]): Promise<string[]> => {
    const folder = join(home, SESSIONS, ...parts)
    try {
      return (await readEntries(folder))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left))
    } catch (error) {
      complete = false
      console.warn(`[codex-history-import] Could not read ${folder}:`, error)
      return []
    }
  }
  const days: string[] = []
  for (const year of await childFolders([])) {
    for (const month of await childFolders([year])) {
      for (const day of await childFolders([year, month])) {
        days.push(join(SESSIONS, year, month, day))
      }
    }
  }
  return { days, complete }
}
