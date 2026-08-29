import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tauriCli = path.join(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js')

const child = spawn(process.execPath, [tauriCli, 'build', ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ORCA_DESKTOP_HOST_PORT: process.env.ORCA_DESKTOP_HOST_PORT ?? '6769',
    ORCA_DESKTOP_HOST_URL: process.env.ORCA_DESKTOP_HOST_URL ?? 'http://127.0.0.1:6769'
  },
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
