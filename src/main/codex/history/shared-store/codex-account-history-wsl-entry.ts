import { watch } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  listCodexIndexPendingRollouts,
  shareCodexAccountHistory,
  unshareCodexAccountHistory
} from './codex-account-history-links'
import { checkThenCleanUpCodexHistory } from './codex-account-history-cleanup'

// Under the host's helper timeout; an unfinished check resumes on a later launch.
const CHECK_BUDGET_MS = 8 * 60_000

// Each share or unshare helper leaves its pid here, holding its start time, while it runs, so a
// check stops for it.
const RUNNING_PASSES = join(homedir(), '.local', 'share', 'orca', 'codex-history-passes')

// The kernel's start time of a process (field 22 of its stat), so a reused pid doesn't match.
async function startTimeOf(pid: string): Promise<string | null> {
  const stat = await readFile(join('/proc', pid, 'stat'), 'utf8').catch(() => null)
  return stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
}

async function isPassRunning(): Promise<boolean> {
  let running = false
  for (const pid of await readdir(RUNNING_PASSES).catch(() => [])) {
    // A marker still being written is a `<pid>.tmp`; it's renamed into place whole.
    if (!/^\d+$/.test(pid)) {
      continue
    }
    const marker = join(RUNNING_PASSES, pid)
    const recorded = await readFile(marker, 'utf8').catch(() => null)
    const started = await startTimeOf(pid)
    // Empty: the helper couldn't read its own start time, so only its pid can tell.
    if (recorded !== null && started !== null && (recorded === started || recorded === '')) {
      running = true
    } else if (recorded !== null) {
      // A helper the distro's shutdown or the host's timeout killed before it removed its marker.
      await unlink(marker).catch(() => {})
    }
  }
  return running
}

// Runs inside a WSL distro on Orca's pinned Node: `<share|unshare|check> <account home> <store home>`.
// Prints each rollout still owed an index row, then `{"result":…,"pendingDir":…}` last.
async function main(): Promise<void> {
  const [mode, accountHome = '', storeHome = ''] = process.argv.slice(2)
  if (!accountHome.startsWith('/') || !storeHome.startsWith('/')) {
    throw new Error('Codex account history needs absolute Linux homes')
  }
  const onWarning = (error: unknown): void => {
    console.error(error instanceof Error ? error.message : String(error))
  }
  // Beside the guest's account homes, so it is per store and never inside the user's ~/.codex.
  const pendingDir = join(homedir(), '.local', 'share', 'orca', 'codex-index-pending')
  if (mode === 'check') {
    const deadline = Date.now() + CHECK_BUDGET_MS
    await mkdir(RUNNING_PASSES, { recursive: true })
    let passRunning = false
    let lookups = 0
    // A pass starting writes its marker here, so the check hears of it without polling. Only the
    // newest lookup counts: an older one finishing late can't clear a pass a newer one saw.
    const watcher = watch(RUNNING_PASSES, () => {
      const lookup = ++lookups
      void isPassRunning().then((running) => {
        if (lookup === lookups) {
          passRunning = running
        }
      })
    })
    // Without the signal a pass could go unnoticed, so the check stops and resumes later.
    let watcherFailed = false
    watcher.on('error', () => {
      watcherFailed = true
    })
    const first = ++lookups
    const runningAtStart = await isPassRunning()
    if (first === lookups) {
      passRunning = runningAtStart
    }
    try {
      const finished = await checkThenCleanUpCodexHistory({
        accountHome,
        storeHome,
        shouldStop: () => passRunning || watcherFailed || Date.now() > deadline
      })
      process.stdout.write(
        `${JSON.stringify({ result: finished ? 'checked' : 'stopped', pendingDir })}\n`
      )
    } finally {
      watcher.close()
    }
    return
  }
  const marker = join(RUNNING_PASSES, String(process.pid))
  await mkdir(RUNNING_PASSES, { recursive: true })
  // Renamed into place, so a check never reads it half written (empty) and deletes it as stale.
  await writeFile(`${marker}.tmp`, (await startTimeOf(String(process.pid))) ?? '')
  await rename(`${marker}.tmp`, marker)
  try {
    await runPass(mode, accountHome, storeHome, pendingDir, onWarning)
  } finally {
    await unlink(marker).catch(() => {})
  }
}

async function runPass(
  mode: string | undefined,
  accountHome: string,
  storeHome: string,
  pendingDir: string,
  onWarning: (error: unknown) => void
): Promise<void> {
  let result: string
  if (mode === 'unshare') {
    const complete = await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })
    result = complete ? 'unshared' : 'incomplete'
  } else {
    result = await shareCodexAccountHistory({
      accountHome,
      storeHome,
      sqliteHome: storeHome,
      indexPendingDir: pendingDir,
      platform: 'linux',
      onWarning
    })
  }
  const pending = await listCodexIndexPendingRollouts(pendingDir)
  process.stdout.write(pending.map((name) => `${name}\n`).join(''))
  process.stdout.write(`${JSON.stringify({ result, pendingDir })}\n`)
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
