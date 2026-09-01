import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const buildScript = fileURLToPath(new URL('./run-electron-vite-build.mjs', import.meta.url))
const verifyRequiresScript = fileURLToPath(
  new URL('./verify-cli-require-resolution.mjs', import.meta.url)
)
const targetConfig = fileURLToPath(new URL('../electron-vite-target.config.ts', import.meta.url))
const targets = ['main', 'preload', 'renderer']

function runNodeScript(args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env
      }
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${label} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`${label} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

function buildTarget(target) {
  return runNodeScript(
    [buildScript, '--config', targetConfig, '--ignoreConfigWarning'],
    { ORCA_ELECTRON_VITE_TARGET: target },
    `Electron Vite ${target} build`
  )
}

const results = await Promise.allSettled(targets.map(buildTarget))
const failures = results.filter((result) => result.status === 'rejected')

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.reason)
  }
  process.exit(1)
}

// Why: build:electron-vite chains this verifier, and Linux packaging takes the
// parallel path — skipping it here reopens the dead-CLI require graph (1.4.150-rc.1.perf).
try {
  await runNodeScript([verifyRequiresScript], {}, 'CLI require resolution check')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
