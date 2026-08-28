import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readBuildProvenance, writeBuildArtifactManifest } from './build-provenance.mjs'

const buildScript = fileURLToPath(new URL('./run-electron-vite-build.mjs', import.meta.url))
const targetConfig = fileURLToPath(new URL('../electron-vite-target.config.ts', import.meta.url))
const targets = ['main', 'preload', 'renderer']
// Compute once before any child can create Vite scratch/output. Every emitted
// target in one artifact must carry the same immutable source provenance.
const provenance = JSON.stringify(readBuildProvenance(process.cwd()))

function buildTarget(target) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [buildScript, '--config', targetConfig, '--ignoreConfigWarning'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          ORCA_ELECTRON_VITE_TARGET: target,
          ORCA_BUILD_PROVENANCE_JSON: provenance
        }
      }
    )

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Electron Vite ${target} build exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`Electron Vite ${target} build exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

const results = await Promise.allSettled(targets.map(buildTarget))
const failures = results.filter((result) => result.status === 'rejected')

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.reason)
  }
  process.exit(1)
}

writeBuildArtifactManifest(process.cwd(), provenance)
