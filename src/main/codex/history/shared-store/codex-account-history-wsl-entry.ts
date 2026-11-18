import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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
  const pendingRoot = join(homedir(), '.local', 'share', 'orca')
  // Markers name rollouts of one store, so each store has its own; ~/.codex keeps earlier builds'.
  const isDefaultStore = resolve(storeHome) === join(homedir(), '.codex')
  const pendingDir = isDefaultStore
    ? join(pendingRoot, 'codex-index-pending')
    : join(
        pendingRoot,
        `codex-index-pending-${createHash('sha256').update(resolve(storeHome)).digest('hex').slice(0, 16)}`
      )
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
  } else if (!isDefaultStore && !(await stat(storeHome).catch(() => null))?.isDirectory()) {
    // A configured folder that isn't there (a typo, an unmounted drive) is never created.
    result = 'failed'
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
