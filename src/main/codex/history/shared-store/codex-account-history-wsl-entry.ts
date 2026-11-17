import { watch } from 'node:fs'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  listCodexIndexPendingRollouts,
  shareCodexAccountHistory,
  unshareCodexAccountHistory
} from './codex-account-history-links'
import { checkThenCleanUpCodexHistory } from './codex-account-history-cleanup'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'

// Under the host's helper timeout; an unfinished check resumes on a later launch.
const CHECK_BUDGET_MS = 8 * 60_000

// Each share or unshare helper leaves its pid here while it runs, so a check stops for it.
const RUNNING_PASSES = join(homedir(), '.local', 'share', 'orca', 'codex-history-passes')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoCodeOrUnknown(error) === 'EPERM'
  }
}

async function isPassRunning(): Promise<boolean> {
  const pids = await readdir(RUNNING_PASSES).catch(() => [])
  return pids.some((name) => /^\d+$/.test(name) && isAlive(Number(name)))
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
    // A pass starting writes its marker here, so the check hears of it without polling.
    const watcher = watch(RUNNING_PASSES, () => {
      void isPassRunning().then((running) => {
        passRunning = running
      })
    })
    // Without the signal a pass could go unnoticed, so the check stops and resumes later.
    watcher.on('error', () => {
      passRunning = true
    })
    passRunning = await isPassRunning()
    try {
      const finished = await checkThenCleanUpCodexHistory({
        accountHome,
        storeHome,
        shouldStop: () => passRunning || Date.now() > deadline
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
  await writeFile(marker, '')
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
