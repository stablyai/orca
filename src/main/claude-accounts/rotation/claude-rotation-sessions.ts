import { basename } from 'node:path'
import { runProcess } from '@orca/process-host'

export const DEFAULT_SESSION_KEY = '(default)'
export const OTHER_SESSION_KEY = '(other)'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function claudeProcessIds(commText: string): Set<string> {
  const pids = new Set<string>()
  for (const line of commText.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (match && (basename(match[2]) === 'claude' || match[2].includes('/claude/versions/'))) {
      pids.add(match[1])
    }
  }
  return pids
}

/** The folder whose Keychain slot a process uses: Claude prefers the secure-storage variable. */
export function claudeSessionKey(commandWithEnv: string, profilesRoot: string): string {
  const home = new RegExp(`^${escapeRegExp(profilesRoot)}/[^/]+/home(?=\\s|$)`)
  for (const name of ['CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR']) {
    const match = new RegExp(`(?:^|\\s)${name}=`).exec(commandWithEnv)
    if (!match) {
      continue
    }
    const rest = commandWithEnv.slice(match.index + match[0].length)
    if (rest === '' || /^\s/.test(rest)) {
      return DEFAULT_SESSION_KEY
    }
    return home.exec(rest)?.[0] ?? OTHER_SESSION_KEY
  }
  return DEFAULT_SESSION_KEY
}

/** Null when a Claude process has no environment line, as when it started between the reads. */
export function countClaudeSessions(
  commText: string,
  envText: string,
  profilesRoot: string
): Map<string, number> | null {
  const pids = claudeProcessIds(commText)
  const counts = new Map<string, number>()
  for (const line of envText.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match || !pids.delete(match[1])) {
      continue
    }
    const key = claudeSessionKey(match[2], profilesRoot)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return pids.size === 0 ? counts : null
}

async function readPs(args: string[]): Promise<string | null> {
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args,
      timeoutMs: 5_000,
      maxOutputBytes: 32 * 1024 * 1024
    })
    return result.code === 0 && !result.timedOut && !result.outputTruncated ? result.stdout : null
  } catch {
    return null
  }
}

/** Claude sessions per folder, including ones started outside Orca. Null when ps fails. */
export async function readClaudeSessionsByHome(
  profilesRoot: string
): Promise<Map<string, number> | null> {
  // Environments first: a Claude process that starts after this read is then missing from
  // them, which reads as uncounted instead of as no session. They stay in memory; only
  // per-folder counts leave this function.
  const env = await readPs(['-axEww', '-o', 'pid=,command='])
  if (env === null) {
    return null
  }
  const comm = await readPs(['-axo', 'pid=,comm='])
  return comm === null ? null : countClaudeSessions(comm, env, profilesRoot)
}
