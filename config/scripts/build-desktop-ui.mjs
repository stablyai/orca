import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const vite = path.join(repoRoot, 'node_modules/vite/bin/vite.js')
const child = spawn(process.execPath, [vite, 'build', '--config', 'vite.desktop.config.ts'], {
  cwd: repoRoot,
  stdio: 'inherit'
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
