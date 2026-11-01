import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appendBuildOldSpaceOption } from './node-old-space-limit.mjs'
import { withRolldownThreadLimit } from './rolldown-thread-limit.mjs'

const require = createRequire(import.meta.url)
const vitePackageJson = require.resolve('vite/package.json')
const viteCli = path.join(path.dirname(vitePackageJson), 'bin', 'vite.js')

// Raise heap for Pi/release runners while reserving memory for OS/bundler on smaller hosts.
const nodeOptions = appendBuildOldSpaceOption(process.env.NODE_OPTIONS)

const child = spawn(
  process.execPath,
  [viteCli, 'build', '--config', 'vite.web.config.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...withRolldownThreadLimit(process.env),
      NODE_OPTIONS: nodeOptions
    }
  }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
