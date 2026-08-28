import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

describe('packaged Windows PTY native capability routing', () => {
  it('runs the packaged executable immediately after the unpacked app is built', () => {
    const job = workflow.jobs.package_windows
    const packageIndex = job.steps.findIndex((step) => step.name === 'Package unpacked app')
    const smokeIndex = job.steps.findIndex(
      (step) => step.name === 'Smoke packaged Windows PTY native capability'
    )
    const smoke = job.steps[smokeIndex]

    expect(job['runs-on']).toBe('windows-2022')
    expect(smokeIndex).toBe(packageIndex + 1)
    expect(smoke.run).toBe(
      'pnpm run smoke:windows-pty-native-capability -- --exe=dist/win-unpacked/Orca.exe'
    )
    expect(smoke.if).toBeUndefined()
    expect(smoke['continue-on-error']).toBeUndefined()
    expect(packageJson.scripts['smoke:windows-pty-native-capability']).toBe(
      'node tests/tools/windows-pty-native-capability-smoke/run.mjs'
    )
  })

  it('keeps patched source rebuild, release build, runtime reuse, and aggregate routing intact', () => {
    const job = workflow.jobs.package_windows
    const install = job.steps.find(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
    const nodeCacheSave = job.steps.find(
      (step) => step.name === 'Save compiled Node native modules'
    )
    const electronCache = job.steps.find(
      (step) => step.name === 'Restore compiled Electron native modules'
    )
    const build = job.steps.find((step) => step.name === 'Build package inputs')
    const prepare = job.steps.find((step) => step.name === 'Prepare Electron native runtime')
    const packageStep = job.steps.find((step) => step.name === 'Package unpacked app')
    const verify = workflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    const ensureNativeRuntime = readFileSync('config/scripts/ensure-native-runtime.mjs', 'utf8')

    expect(install.with['native-runtime']).toBe('node')
    expect(install.with['persist-native-cache']).toBe('false')
    expect(nodeCacheSave.uses).toBe('actions/cache/save@v5')
    expect(nodeCacheSave.with.key).toContain('-node-node')
    expect(electronCache.with.key).toContain('-electron-node')
    expect(ensureNativeRuntime).toContain("runPnpm(['exec', 'node-gyp', 'rebuild']")
    expect(ensureNativeRuntime).toContain("resolve(moduleDir, 'scripts', 'post-install.js')")
    expect(build.run).toBe('pnpm run build:release:parallel')
    expect(build.env.ORCA_REUSE_WINDOWS_CLI_LAUNCHER).toBe('1')
    expect(prepare.run).toBe('node config/scripts/ensure-native-runtime.mjs --runtime=electron')
    expect(packageStep.env.ORCA_REUSE_PREPARED_NATIVE_RUNTIME).toBe('1')
    expect(workflow.jobs.verify.needs).toContain('package_windows')
    expect(verify.env.PACKAGE_WINDOWS).toBe('${{ needs.package_windows.result }}')
    expect(verify.run).toContain('"$PACKAGE_WINDOWS"')
  })

  it('keeps the native probe event-based, scoped, and runnable in packaged Node mode', () => {
    const driver = readFileSync('tests/tools/windows-pty-native-capability-smoke/run.mjs', 'utf8')
    const probe = readFileSync(
      'tests/tools/windows-pty-native-capability-smoke/packaged-node-pty-capability-probe.cjs',
      'utf8'
    )
    const source = `${driver}\n${probe}`

    expect(driver).toContain("ELECTRON_RUN_AS_NODE: '1'")
    expect(source).not.toMatch(/\b(?:sleep|tasklist|taskkill)\b/i)
    expect(source).not.toContain('maxRetries')
    expect(source).not.toContain('retryDelay')
    expect(source).not.toContain("from 'node:child_process'")
    expect(source).not.toContain("require('node:child_process')")
    expect(probe).toContain("'System32', 'wscript.exe'")
    expect(probe).toContain('real-orca-detached-launcher.vbs')
    expect(probe).not.toMatch(/cmd\.exe|start "" \/b/i)
    expect(probe).toContain('native.terminateJob(target._pty, target.pid)')
  })
})
