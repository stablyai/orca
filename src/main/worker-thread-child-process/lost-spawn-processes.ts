import { readdir, readFile } from 'node:fs/promises'

/** Every child the isolated spawner starts carries its own value; its descendants inherit it. */
export const SPAWN_KEY_ENV = 'ORCA_SPAWN_KEY'

const FIRST_CHECK_MS = 50
const MAX_CHECK_MS = 30_000

async function pidsWithKeys(keys: ReadonlySet<string>): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return found
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) {
        return
      }
      let environ: string
      try {
        // Only Orca's own children match; other users' processes refuse the read.
        environ = await readFile(`/proc/${entry}/environ`, 'latin1')
      } catch {
        return
      }
      for (const variable of environ.split('\0')) {
        if (variable.startsWith(`${SPAWN_KEY_ENV}=`)) {
          const key = variable.slice(SPAWN_KEY_ENV.length + 1)
          if (keys.has(key)) {
            found.set(Number(entry), key)
          }
          return
        }
      }
    })
  )
  return found
}

async function pidHasKey(pid: number, key: string): Promise<boolean> {
  try {
    const environ = await readFile(`/proc/${pid}/environ`, 'latin1')
    return environ.split('\0').includes(`${SPAWN_KEY_ENV}=${key}`)
  } catch {
    return false
  }
}

/**
 * Linux: the spawner that started these children is gone, and with it every pid and exit it had
 * not yet reported. Find their processes by spawn key, kill each one whose key still matches right
 * before the kill (so a reused pid is never hit), and resolve once none is left. Resolves with the
 * keys that had a process, so a child that never started can still be told apart.
 */
export async function endLostSpawns(keys: readonly string[]): Promise<Set<string>> {
  const pending = new Set(keys)
  const started = new Set<string>()
  let delayMs = FIRST_CHECK_MS
  // A fork caught before its exec doesn't carry the key yet; a second look after it settles does.
  let quietRounds = 0
  while (pending.size > 0 && quietRounds < 2) {
    const live = await pidsWithKeys(pending)
    if (live.size === 0) {
      quietRounds += 1
    } else {
      quietRounds = 0
      for (const [pid, key] of live) {
        started.add(key)
        if (await pidHasKey(pid, key)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Gone between the check and the kill; the next scan proves it.
          }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
    delayMs = live.size === 0 ? FIRST_CHECK_MS : Math.min(delayMs * 2, MAX_CHECK_MS)
  }
  return started
}
