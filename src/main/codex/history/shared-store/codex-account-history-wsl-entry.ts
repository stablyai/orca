import {
  listCodexIndexPendingRollouts,
  shareCodexAccountHistory,
  unshareCodexAccountHistory
} from './codex-account-history-links'

// Runs inside a WSL distro on Orca's pinned Node: `<share|unshare> <account home> <store home>`.
// Prints each rollout still owed an index row, then `{"result":…}` last.
async function main(): Promise<void> {
  const [mode, accountHome = '', storeHome = ''] = process.argv.slice(2)
  if (!accountHome.startsWith('/') || !storeHome.startsWith('/')) {
    throw new Error('Codex account history needs absolute Linux homes')
  }
  const onWarning = (error: unknown): void => {
    console.error(error instanceof Error ? error.message : String(error))
  }
  if (mode === 'unshare') {
    await unshareCodexAccountHistory({ accountHome, storeHome, onWarning })
    process.stdout.write(`${JSON.stringify({ result: 'unshared' })}\n`)
    return
  }
  const result = await shareCodexAccountHistory({
    accountHome,
    storeHome,
    platform: 'linux',
    onWarning
  })
  const pending = await listCodexIndexPendingRollouts(accountHome)
  process.stdout.write(pending.map((name) => `${name}\n`).join(''))
  process.stdout.write(`${JSON.stringify({ result })}\n`)
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
