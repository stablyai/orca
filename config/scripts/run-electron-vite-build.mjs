import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appendBuildOldSpaceOption } from './node-old-space-limit.mjs'
import { withRolldownThreadLimit } from './rolldown-thread-limit.mjs'
import { RENDERER_BUILD_DIR, verifyRendererBootGraph } from './renderer-boot-graph.mjs'

const require = createRequire(import.meta.url)
const electronVitePackageJson = require.resolve('electron-vite/package.json')
const electronViteCli = path.join(path.dirname(electronVitePackageJson), 'bin', 'electron-vite.js')

// Reserve OS memory on smaller hosts; release renderer builds have OOMed GitHub macOS runners.
const nodeOptions = appendBuildOldSpaceOption(process.env.NODE_OPTIONS)

const child = spawn(process.execPath, [electronViteCli, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...withRolldownThreadLimit(process.env),
    NODE_OPTIONS: nodeOptions
  }
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  if (code !== 0) {
    process.exit(code ?? 1)
  }

  // Check boot graph only after renderer target completes; parallel main/preload targets must not read half-written renderer output.
  const target = process.env.ORCA_ELECTRON_VITE_TARGET
  const builtRenderer =
    (!target || target === 'renderer') && fs.existsSync(path.join(RENDERER_BUILD_DIR, 'index.html'))
  process.exit(builtRenderer ? verifyRendererBootGraph() : 0)
})
