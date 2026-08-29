import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const entry = path.join(repoRoot, 'src/desktop-host/desktop-host-entry.ts')

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', entry, ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORCA_DESKTOP_HOST_PORT: process.env.ORCA_DESKTOP_HOST_PORT ?? '6769'
    },
    stdio: 'inherit'
  }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
