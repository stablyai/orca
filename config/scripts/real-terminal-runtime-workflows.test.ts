import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const prepare = 'node config/scripts/build-orcad-bun.mjs --runtime-only --out-dir out/orcad'

describe('real terminal test runtime preparation', () => {
  it.each([
    ['pr.yml', 'shell_contracts', 'Test real shell contracts'],
    ['pr.yml', 'package_windows', 'Test Windows-specific boundaries'],
    ['unit-tests.yml', 'test', 'Test shard']
  ])('prepares pinned Bun before %s/%s executes %s', (file, job, testStep) => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, 'utf8'))
    const steps = workflow.jobs[job].steps
    const testIndex = steps.findIndex((step: { name?: string }) => step.name === testStep)
    const preparation = steps.findIndex((step: { run?: string }) => step.run === prepare)
    expect(preparation).toBeGreaterThan(-1)
    expect(preparation).toBeLessThan(testIndex)
    expect(steps[preparation].if).toBeUndefined()
    expect(steps[preparation]['continue-on-error']).toBeUndefined()
  })
})

it('runs the shell exec regression with Bun before Node-based shell contracts', () => {
  const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
  const step = workflow.jobs.shell_contracts.steps.find(
    (entry: { name?: string }) => entry.name === 'Test real shell contracts'
  )
  const file = 'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts'
  const [bun, ...node] = step.run.trim().split('\n')
  expect(bun).toContain(`node config/scripts/run-bun-profile-tests.mjs --maxWorkers=1 ${file}`)
  expect(node.join('\n')).not.toContain(file)
})

describe('desktop terminal build closure', () => {
  it.each([
    ['pr.yml', 'package', 'Build package inputs'],
    ['e2e.yml', 'build', 'Build E2E outputs']
  ])('builds the runtime and daemon before %s/%s packaging or upload', (file, job, stepName) => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, 'utf8'))
    const step = workflow.jobs[job].steps.find(
      (entry: { name?: string }) => entry.name === stepName
    )
    expect(step.run).toContain('build:cli')
    expect(step.run).toContain('build:terminal-daemon')
  })
  it('prepares the runtime and daemon before launching the development app', () => {
    const source = readFileSync('config/scripts/run-electron-vite-dev.mjs', 'utf8')
    expect(source).toContain('if (!isHelpOrVersion) {\n  await buildCliRuntime')
    const launch = source.indexOf('const child = spawn(')
    for (const call of [
      'await buildCliRuntime(process.platform, process.arch)',
      'await buildTerminalDaemon()'
    ]) {
      expect(source.indexOf(call)).toBeGreaterThan(-1)
      expect(source.indexOf(call)).toBeLessThan(launch)
    }
  })
  it('repairs missing E2E runtime and daemon outputs even with SKIP_BUILD', () => {
    const source = readFileSync('tests/e2e/global-setup.ts', 'utf8')
    expect(source).toContain('!existsSync(runtimeManifest) || !existsSync(runtimeBinary)')
    expect(source).toContain('!existsSync(terminalEntry) || !existsSync(terminalGate)')
    expect(source).toContain('node config/scripts/build-terminal-daemon.mjs')
    expect(source).toContain("['config/scripts/build-cli-runtime.mjs', '--arch', process.arch]")
  })
  it('does not silently filter retired terminal suites out of reliability commands', () => {
    const gates = readFileSync('config/reliability-gates.jsonc', 'utf8')
    expect(gates).not.toMatch(
      /(?:local-pty-provider-(?:foreground-process|shell-readiness|spawn-session|shutdown|session-inventory)|local-pty-shell-ready-startup-command|degraded-daemon-pty-provider|omp-shell-wrapper\.node-pty)\.test\.ts/
    )
  })
})
