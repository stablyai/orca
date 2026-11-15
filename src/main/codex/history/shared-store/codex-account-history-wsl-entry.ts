import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  listCodexIndexPendingRollouts,
  shareCodexAccountHistory,
  unshareCodexAccountHistory
} from './codex-account-history-links'
import { checkCodexHistoryLeftBehind } from './codex-account-history-content-check'

// Under the host's helper timeout; an unfinished check resumes on a later launch.
const CHECK_BUDGET_MS = 8 * 60_000

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
  let result: string
  if (mode === 'check') {
    const deadline = Date.now() + CHECK_BUDGET_MS
    const finished = await checkCodexHistoryLeftBehind({
      accountHome,
      storeHome,
      shouldStop: () => Date.now() > deadline
    })
    process.stdout.write(
      `${JSON.stringify({ result: finished ? 'checked' : 'stopped', pendingDir })}\n`
    )
    return
  }
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
