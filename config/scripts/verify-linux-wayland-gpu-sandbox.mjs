#!/usr/bin/env node

import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { collectRendererDiagnostics } from './linux-wayland-renderer-diagnostics.mjs'
import {
  assertKeyboardInputWorks,
  assertScrollbackBufferWorks,
  setupTerminal
} from './linux-wayland-terminal-exercise.mjs'
import {
  createPhaseLogger,
  runWithTimeout,
  startValidationWatchdog
} from './linux-wayland-validation-watchdog.mjs'

const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const outMain = path.join(rootDir, 'out', 'main', 'index.js')
const timeoutMs = 45_000
const rendererSetupTimeoutMs = 30_000
const appCloseTimeoutMs = 5_000
const validationWatchdogMs = 7 * 60_000
const gpuCrashPattern =
  /GPU process (?:exited unexpectedly|isn't usable)|gpu_data_manager|exit[_ -]?code=8704/i

class MissingReproductionError extends Error {}

function hasBaseReproductionEvidence({ error, gpuCrashLines, phase, terminalExerciseStarted }) {
  if (error instanceof MissingReproductionError) {
    return false
  }
  return (
    terminalExerciseStarted ||
    gpuCrashLines.length > 0 ||
    // Why: the unfixed Wayland GPU path can wedge before the terminal receives
    // a PTY; reaching this boundary means the terminal pane itself is present.
    phase === 'setup.wait-pty'
  )
}

function parseArgs() {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))
  const mode = modeArg?.slice('--mode='.length) ?? 'verify-fix'
  if (mode !== 'verify-fix' && mode !== 'expect-repro') {
    throw new Error(`Unsupported --mode=${mode}`)
  }
  return { mode }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    ...options
  })
}

function assertWaylandHost() {
  if (process.platform !== 'linux') {
    throw new Error('Wayland GPU sandbox validation must run on Linux.')
  }
  if (
    !process.env.WAYLAND_DISPLAY &&
    process.env.XDG_SESSION_TYPE !== 'wayland' &&
    process.env.ELECTRON_OZONE_PLATFORM_HINT !== 'wayland'
  ) {
    throw new Error('Wayland GPU sandbox validation requires a Wayland session.')
  }
}

function ensureElectronRuntime() {
  run(process.execPath, ['config/scripts/ensure-native-runtime.mjs', '--runtime=electron'])
}

function buildAppIfNeeded() {
  if (process.env.SKIP_BUILD === '1' && existsSync(outMain)) {
    console.log('[wayland-gpu] SKIP_BUILD=1 and out/main/index.js exists; skipping build.')
    return
  }
  run('npx', ['electron-vite', 'build', '--mode', 'e2e'])
}

function createGitRepo() {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'orca-wayland-gpu-repo-'))
  run('git', ['init'], { cwd: repoDir, stdio: 'pipe' })
  run('git', ['config', 'user.email', 'wayland-gpu@test.local'], { cwd: repoDir, stdio: 'pipe' })
  run('git', ['config', 'user.name', 'Wayland GPU Test'], { cwd: repoDir, stdio: 'pipe' })
  writeFileSync(path.join(repoDir, 'README.md'), '# Wayland GPU sandbox validation\n')
  writeFileSync(path.join(repoDir, 'package.json'), '{"private":true,"type":"module"}\n')
  run('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' })
  run('git', ['commit', '-m', 'Initial validation fixture'], { cwd: repoDir, stdio: 'pipe' })
  return repoDir
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function closeElectronApp(app) {
  if (!app) {
    return
  }

  const electronProcess = app.process()
  let closeError
  const didClose = await Promise.race([
    app.close().then(
      () => true,
      (error) => {
        closeError = error
        return false
      }
    ),
    delay(appCloseTimeoutMs).then(() => false)
  ])

  if (didClose) {
    return
  }

  if (closeError) {
    console.warn(
      `[wayland-gpu] Electron close failed: ${closeError instanceof Error ? closeError.message : closeError}`
    )
  }
  // Why: reproducing the Wayland GPU stall can wedge Chromium teardown after
  // the evidence is collected, so CI needs a bounded close path.
  if (electronProcess && electronProcess.exitCode === null && electronProcess.signalCode === null) {
    console.warn('[wayland-gpu] Electron did not close cleanly; killing the app process.')
    electronProcess.kill('SIGKILL')
    await Promise.race([
      new Promise((resolve) => electronProcess.once('exit', resolve)),
      delay(appCloseTimeoutMs)
    ])
  }
}

async function runValidation(mode) {
  assertWaylandHost()
  ensureElectronRuntime()
  buildAppIfNeeded()

  const repoPath = createGitRepo()
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'orca-wayland-gpu-userdata-'))
  // Why: this harness cannot use the E2E flag because that disables Linux GPU,
  // but its Codex and Node home still must stay inside the disposable profile.
  const isolatedHome = path.join(userDataPath, 'home')
  mkdirSync(isolatedHome, { recursive: true })
  const runId = `${Date.now()}`
  let app
  let page
  let terminalExerciseStarted = false
  let commandLineSwitches = null
  const stderrLines = []
  const validationState = {
    startedAt: Date.now(),
    phase: 'initial'
  }
  const logPhase = createPhaseLogger({
    startedAt: validationState.startedAt,
    onPhase: (phase) => {
      validationState.phase = phase
    }
  })
  const stopWatchdog = startValidationWatchdog({
    timeoutMs: validationWatchdogMs,
    onTimeout: async () => {
      const gpuCrashLines = stderrLines.filter((line) => gpuCrashPattern.test(line))
      const rendererDiagnostics = await collectRendererDiagnostics(page)
      const reproduced =
        mode === 'expect-repro' && (terminalExerciseStarted || gpuCrashLines.length > 0)
      const payload = {
        mode,
        watchdogTimedOut: true,
        reproduced,
        phase: validationState.phase,
        elapsedMs: Date.now() - validationState.startedAt,
        switches: commandLineSwitches,
        rendererDiagnostics,
        gpuCrashLines
      }
      const output = JSON.stringify(payload, null, 2)
      if (reproduced) {
        console.log(output)
        return 0
      }
      console.error(output)
      return 1
    }
  })

  try {
    const {
      ELECTRON_RUN_AS_NODE: _unused,
      DISPLAY: _display,
      CODEX_HOME: _codexHome,
      ORCA_CODEX_HOME: _orcaCodexHome,
      ...env
    } = process.env
    void _unused
    void _display
    void _codexHome
    void _orcaCodexHome
    logPhase('launch.start')
    app = await runWithTimeout(
      'Electron launch',
      () =>
        electron.launch({
          args: ['--ozone-platform=wayland', outMain],
          env: {
            ...env,
            NODE_ENV: 'development',
            ORCA_DEV_USER_DATA_PATH: userDataPath,
            HOME: isolatedHome,
            USERPROFILE: isolatedHome,
            ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME: '0',
            ELECTRON_ENABLE_LOGGING: '1',
            ELECTRON_ENABLE_STACK_DUMPING: '1',
            ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
            XDG_SESSION_TYPE: 'wayland'
          }
        }),
      timeoutMs
    )
    logPhase('launch.done')
    app.process().stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderrLines.push(...text.split(/\r?\n/).filter(Boolean))
      if (process.env.ORCA_WAYLAND_GPU_VERBOSE === '1') {
        process.stderr.write(text)
      }
    })

    logPhase('app.when-ready')
    await runWithTimeout(
      'Electron app readiness',
      () =>
        app.evaluate(async ({ app: electronApp }) => {
          await electronApp.whenReady()
        }),
      rendererSetupTimeoutMs
    )
    commandLineSwitches = await runWithTimeout(
      'Electron command-line switches',
      () =>
        app.evaluate(({ app: electronApp }) => ({
          disableGpuSandbox: electronApp.commandLine.hasSwitch('disable-gpu-sandbox'),
          disableGpu: electronApp.commandLine.hasSwitch('disable-gpu'),
          ozonePlatform: electronApp.commandLine.getSwitchValue('ozone-platform'),
          enableFeatures: electronApp.commandLine.getSwitchValue('enable-features')
        })),
      rendererSetupTimeoutMs
    )
    logPhase(
      'app.switches',
      `disableGpuSandbox=${commandLineSwitches.disableGpuSandbox} disableGpu=${commandLineSwitches.disableGpu}`
    )

    if (mode === 'expect-repro' && commandLineSwitches.disableGpuSandbox) {
      throw new MissingReproductionError(
        'Base run already has --disable-gpu-sandbox; cannot validate the unfixed Wayland path.'
      )
    }
    if (mode === 'expect-repro' && commandLineSwitches.disableGpu) {
      throw new MissingReproductionError(
        'Base run has --disable-gpu; hardware acceleration is disabled and would mask the GPU sandbox path.'
      )
    }
    if (mode === 'verify-fix' && !commandLineSwitches.disableGpuSandbox) {
      throw new Error('Expected --disable-gpu-sandbox on Linux Wayland, but it was absent.')
    }
    if (mode === 'verify-fix' && commandLineSwitches.disableGpu) {
      throw new Error('Expected hardware acceleration to remain enabled, but --disable-gpu is set.')
    }

    logPhase('window.first')
    page = await runWithTimeout('first renderer window', () => app.firstWindow(), timeoutMs)
    logPhase('window.load')
    await runWithTimeout(
      'renderer domcontentloaded',
      () => page.waitForLoadState('domcontentloaded'),
      rendererSetupTimeoutMs
    )
    logPhase('window.loaded')
    const ptyId = await setupTerminal(page, repoPath, logPhase)
    terminalExerciseStarted = true
    logPhase('exercise.start')
    const scroll = await assertScrollbackBufferWorks(page, ptyId, runId, logPhase)
    const typedMarkers = await assertKeyboardInputWorks(page, ptyId, repoPath, runId, logPhase)
    const gpuCrashLines = stderrLines.filter((line) => gpuCrashPattern.test(line))

    if (mode === 'expect-repro') {
      throw new MissingReproductionError(
        'Terminal input and scroll stayed responsive without the fix on this host.'
      )
    }
    if (gpuCrashLines.length > 0) {
      throw new Error(`GPU crash evidence appeared in stderr:\n${gpuCrashLines.join('\n')}`)
    }

    console.log(
      JSON.stringify(
        {
          mode,
          phase: validationState.phase,
          waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
          xdgSessionType: process.env.XDG_SESSION_TYPE ?? null,
          switches: commandLineSwitches,
          scroll,
          typedMarkers,
          gpuCrashLines
        },
        null,
        2
      )
    )
  } catch (error) {
    const gpuCrashLines = stderrLines.filter((line) => gpuCrashPattern.test(line))
    const rendererDiagnostics = await collectRendererDiagnostics(page)
    if (
      mode === 'expect-repro' &&
      hasBaseReproductionEvidence({
        error,
        gpuCrashLines,
        phase: validationState.phase,
        terminalExerciseStarted
      })
    ) {
      console.log(
        JSON.stringify(
          {
            mode,
            reproduced: true,
            reason: error instanceof Error ? error.message : String(error),
            phase: validationState.phase,
            switches: commandLineSwitches,
            rendererDiagnostics,
            gpuCrashLines
          },
          null,
          2
        )
      )
      return
    }
    console.error(
      JSON.stringify(
        {
          mode,
          reason: error instanceof Error ? error.message : String(error),
          phase: validationState.phase,
          switches: commandLineSwitches,
          rendererDiagnostics,
          gpuCrashLines
        },
        null,
        2
      )
    )
    throw error
  } finally {
    stopWatchdog()
    await closeElectronApp(app)
    rmSync(repoPath, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  }
}

const { mode } = parseArgs()
runValidation(mode).then(
  () => {
    // Why: a reproduced GPU stall can leave Playwright/Electron handles alive
    // after cleanup; CI should finish once validation has made its decision.
    process.exit(0)
  },
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exit(1)
  }
)
