import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronVitePackageJson = require.resolve('electron-vite/package.json')
const electronViteCli = path.join(path.dirname(electronVitePackageJson), 'bin', 'electron-vite.js')
const requestedNodeOptions = '--max-old-space-size=4096'
const existingNodeOptions = process.env.NODE_OPTIONS?.trim()

// Release builds have started OOMing on GitHub's macOS runners during the
// renderer bundle, so we force a larger heap here in one shared entrypoint
// instead of relying on shell-specific env syntax in individual scripts.
const nodeOptions = existingNodeOptions
  ? `${existingNodeOptions} ${requestedNodeOptions}`
  : requestedNodeOptions

const child = spawn(process.execPath, [electronViteCli, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions
  }
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
