import { runCodexConfigSyncWslPass } from './codex-config-sync-wsl-pass'

// Runs inside a WSL distro on Orca's pinned Node; prints one JSON line last.
try {
  const output = runCodexConfigSyncWslPass(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(output)}\n`)
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
