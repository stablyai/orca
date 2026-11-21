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

async function childFolders(folder: string): Promise<string[]> {
  return (await readEntries(folder))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
}

/** Day folders under `sessions/`, newest first, relative to the home. */
export async function listDayFolders(home: string): Promise<string[]> {
  const days: string[] = []
  for (const year of await childFolders(join(home, SESSIONS))) {
    for (const month of await childFolders(join(home, SESSIONS, year))) {
      for (const day of await childFolders(join(home, SESSIONS, year, month))) {
        days.push(join(SESSIONS, year, month, day))
      }
    }
  }
  return days
}
