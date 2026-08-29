import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const children = []

function spawnBackend(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORCA_DESKTOP_HOST_PORT: process.env.ORCA_DESKTOP_HOST_PORT ?? '6769',
      ORCA_DESKTOP_HOST_URL: process.env.ORCA_DESKTOP_HOST_URL ?? 'http://127.0.0.1:6769',
      ...extraEnv
    },
    stdio: 'inherit'
  })
  children.push(child)
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return
    }
    shutdown(signal ? 1 : (code ?? 1))
  })
  return child
}

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

spawnBackend(process.execPath, [
  '--experimental-strip-types',
  path.join(repoRoot, 'src/desktop-host/desktop-host-entry.ts')
])
spawnBackend(process.execPath, [
  path.join(repoRoot, 'node_modules/vite/bin/vite.js'),
  '--config',
  'vite.desktop.config.ts',
  '--host',
  '127.0.0.1',
  '--port',
  '5174'
])
