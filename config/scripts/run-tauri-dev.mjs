import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

delete process.env.ELECTRON_RUN_AS_NODE

const ensure = spawn(
  process.execPath,
  [path.join(repoRoot, 'config/scripts/ensure-native-runtime.mjs'), '--runtime=node'],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
)

ensure.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1)
    return
  }
  const tauriCli = path.join(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')
  const child = spawn(process.execPath, [tauriCli, 'dev', ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORCA_DESKTOP_HOST_PORT: process.env.ORCA_DESKTOP_HOST_PORT ?? '6769',
      ORCA_DESKTOP_HOST_URL: process.env.ORCA_DESKTOP_HOST_URL ?? 'http://127.0.0.1:6769'
    },
    stdio: 'inherit'
  })
  child.on('exit', (exitCode, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(exitCode ?? 1)
  })
})
