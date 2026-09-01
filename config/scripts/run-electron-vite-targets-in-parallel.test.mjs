import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
const runnerSource = readFileSync(
  join(projectDir, 'config/scripts/run-electron-vite-targets-in-parallel.mjs'),
  'utf8'
)

// Why: the serial script is the source of truth for what a completed
// electron-vite build owes, so renaming its verifier fails here instead of
// silently leaving the parallel path — the one Linux packaging takes — unverified.
const serialVerifier = packageJson.scripts['build:electron-vite'].match(
  /config\/scripts\/(verify-[\w-]+\.mjs)/
)?.[1]

describe('parallel electron-vite target runner', () => {
  it('verifies the compiled CLI require graph like the serial build does', () => {
    expect(serialVerifier).toBe('verify-cli-require-resolution.mjs')
    expect(runnerSource).toContain(`./${serialVerifier}`)
  })

  it('runs the verifier only after every target build succeeded', () => {
    const failureGate = runnerSource.indexOf('failures.length > 0')
    const verifierRun = runnerSource.indexOf('runNodeScript([verifyRequiresScript]')

    expect(failureGate).toBeGreaterThan(-1)
    expect(verifierRun).toBeGreaterThan(failureGate)
  })

  it('keeps packaging on the parallel entry point this runner backs', () => {
    expect(packageJson.scripts['build:electron-vite:parallel']).toContain(
      'run-electron-vite-targets-in-parallel.mjs'
    )
  })
})
