import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupE2ERunScope, prepareE2ERunScope } from '../../tests/e2e/e2e-run-scope-runtime.mts'
import {
  getHeavySuiteLockPath,
  normalizeForwardedArgs,
  resolveSuitePlan,
  runHeavyTestSuite,
  terminateChildTree,
  wrapWindowsHeavySuiteStep
} from './run-heavy-test-suite.mjs'

const fixturePath = fileURLToPath(
  new URL('./test-fixtures/heavy-suite-admission-fixture.mjs', import.meta.url)
)
const testRoots = []
const spawnedProcesses = new Set()

function createTestRoot() {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-heavy-suite-test-'))
  testRoots.push(testRoot)
  return testRoot
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

afterEach(async () => {
  vi.useRealTimers()
  for (const child of spawnedProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([waitForExit(child), new Promise((resolve) => setTimeout(resolve, 2_000))])
    }
  }
  spawnedProcesses.clear()
  for (const testRoot of testRoots.splice(0)) {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

describe('heavy test suite admission', () => {
  it('rejects Windows batch commands instead of passing arguments through cmd.exe', () => {
    expect(() =>
      wrapWindowsHeavySuiteStep({ command: 'pnpm.cmd', args: ['test', '& calc'] }, 'win32')
    ).toThrow(/batch commands/i)
  })

  it('keeps admission until a spawned child closes when metadata publication fails', async () => {
    const testRoot = createTestRoot()
    const child = new EventEmitter()
    child.pid = 4321
    child.unref = vi.fn()
    const terminateChild = vi.fn(() => {
      expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(true)
      setTimeout(() => child.emit('close', 0, null), 10)
    })
    let updateCount = 0

    const result = await runHeavyTestSuite({
      suite: 'fixture',
      steps: [{ command: 'fixture', args: [] }],
      tempDir: testRoot,
      spawnProcess: vi.fn(() => child),
      terminateChild,
      updateChildState: (handle, state) => {
        updateCount += 1
        if (state.phase === 'running') {
          throw new Error('metadata write failed')
        }
        return handle
      }
    })

    expect(result).toBe(1)
    expect(terminateChild).toHaveBeenCalledWith(4321, 'SIGTERM', expect.any(Object))
    expect(updateCount).toBe(2)
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
  })

  it('does not spawn a child when shutdown arrives while publishing spawning state', async () => {
    const testRoot = createTestRoot()
    const signalSource = new EventEmitter()
    const spawnProcess = vi.fn()
    let preparedRun = null
    const prepareRun = () => {
      preparedRun = prepareE2ERunScope({ tempDir: testRoot, env: {} })
    }
    const cleanupRun = vi.fn(() => {
      cleanupE2ERunScope(preparedRun.scope, { allowMissingManifest: true })
    })

    const result = await runHeavyTestSuite({
      suite: 'fixture',
      steps: [{ command: 'fixture', args: [] }],
      tempDir: testRoot,
      signalSource,
      spawnProcess,
      prepareRun,
      cleanupRun,
      updateChildState: (handle, state) => {
        if (state.phase === 'spawning') {
          signalSource.emit('SIGTERM')
        }
        return handle
      }
    })

    expect(result).toBe(143)
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(cleanupRun).toHaveBeenCalledOnce()
    expect(existsSync(preparedRun.scope.manifestFile)).toBe(false)
    expect(existsSync(preparedRun.testRepoDir)).toBe(false)
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
  })

  it('terminates a child spawned during shutdown and then runs owned cleanup', async () => {
    const testRoot = createTestRoot()
    const signalSource = new EventEmitter()
    const child = new EventEmitter()
    child.pid = 4321
    let preparedRun = null
    const prepareRun = () => {
      preparedRun = prepareE2ERunScope({ tempDir: testRoot, env: {} })
    }
    const cleanupRun = vi.fn(() => {
      cleanupE2ERunScope(preparedRun.scope, { allowMissingManifest: true })
    })
    const terminateChild = vi.fn(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
    })
    const spawnProcess = vi.fn(() => {
      signalSource.emit('SIGHUP')
      return child
    })

    const result = await runHeavyTestSuite({
      suite: 'fixture',
      steps: [{ command: 'fixture', args: [] }],
      tempDir: testRoot,
      signalSource,
      spawnProcess,
      terminateChild,
      prepareRun,
      cleanupRun
    })

    expect(result).toBe(129)
    expect(terminateChild).toHaveBeenCalledWith(4321, 'SIGHUP', expect.any(Object))
    expect(cleanupRun).toHaveBeenCalledOnce()
    expect(existsSync(preparedRun.scope.manifestFile)).toBe(false)
    expect(existsSync(preparedRun.testRepoDir)).toBe(false)
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
  })

  it('reclaims owned E2E resources after escalating an unresponsive child', async () => {
    vi.useFakeTimers()
    const testRoot = createTestRoot()
    const signalSource = new EventEmitter()
    const child = new EventEmitter()
    child.pid = 4321
    let preparedRun = null
    const prepareRun = () => {
      preparedRun = prepareE2ERunScope({ tempDir: testRoot, env: {} })
    }
    const cleanupRun = vi.fn(() => {
      cleanupE2ERunScope(preparedRun.scope, { allowMissingManifest: true })
    })
    const terminateChild = vi.fn((_pid, signal) => {
      if (signal === 'SIGKILL') {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
      }
    })
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => signalSource.emit('SIGTERM'))
      return child
    })

    const resultPromise = runHeavyTestSuite({
      suite: 'fixture',
      steps: [{ command: 'fixture', args: [] }],
      tempDir: testRoot,
      signalSource,
      spawnProcess,
      terminateChild,
      prepareRun,
      cleanupRun,
      forceKillAfterMs: 10
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(20)
    const result = await resultPromise

    expect(result).toBe(143)
    expect(terminateChild).toHaveBeenNthCalledWith(1, 4321, 'SIGTERM', expect.any(Object))
    expect(terminateChild).toHaveBeenNthCalledWith(2, 4321, 'SIGKILL', expect.any(Object))
    expect(cleanupRun).toHaveBeenCalledOnce()
    expect(existsSync(preparedRun.scope.manifestFile)).toBe(false)
    expect(existsSync(preparedRun.testRepoDir)).toBe(false)
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
  })

  it('keeps admission and escalation ownership after the direct child closes', async () => {
    vi.useFakeTimers()
    const testRoot = createTestRoot()
    const signalSource = new EventEmitter()
    const child = new EventEmitter()
    child.pid = 4321
    let treeAlive = true
    const cleanupRun = vi.fn(() => {
      expect(treeAlive).toBe(false)
    })
    const terminateChild = vi.fn((_pid, signal) => {
      if (signal === 'SIGTERM') {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
      } else if (signal === 'SIGKILL') {
        treeAlive = false
      }
    })
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => signalSource.emit('SIGTERM'))
      return child
    })

    const resultPromise = runHeavyTestSuite({
      suite: 'fixture',
      steps: [{ command: 'fixture', args: [] }],
      tempDir: testRoot,
      signalSource,
      spawnProcess,
      terminateChild,
      cleanupRun,
      isChildTreeAlive: () => treeAlive,
      forceKillAfterMs: 10
    })
    await Promise.resolve()
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    const result = await resultPromise

    expect(result).toBe(143)
    expect(terminateChild).toHaveBeenNthCalledWith(1, 4321, 'SIGTERM', expect.any(Object))
    expect(terminateChild).toHaveBeenNthCalledWith(2, 4321, 'SIGKILL', expect.any(Object))
    expect(cleanupRun).toHaveBeenCalledOnce()
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
  })

  it('runs Windows steps in a kill-on-close job and terminates by retained handle', async () => {
    const testRoot = createTestRoot()
    const signalSource = new EventEmitter()
    const child = new EventEmitter()
    child.pid = 4321
    child.kill = vi.fn()
    const terminateChild = vi.fn()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        signalSource.emit('SIGTERM')
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      return child
    })

    const result = await runHeavyTestSuite({
      suite: 'fixture',
      steps: [
        {
          command: 'fixture',
          args: ['--flag', 'space value', 'quote"value', '&|^%'],
          env: { PATH: process.env.PATH, REPORT_MARKER: '1' },
          stdio: ['ignore', 42, 43]
        }
      ],
      tempDir: testRoot,
      platform: 'win32',
      signalSource,
      spawnProcess,
      terminateChild
    })

    expect(result).toBe(143)
    expect(spawnProcess).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-File']),
      expect.objectContaining({ detached: false, stdio: ['ignore', 42, 43] })
    )
    const wrapperEnvironment = spawnProcess.mock.calls[0][2].env
    expect(
      JSON.parse(
        Buffer.from(wrapperEnvironment.ORCA_WINDOWS_HEAVY_SUITE_STEP, 'base64').toString('utf8')
      )
    ).toEqual({ command: 'fixture', args: ['--flag', 'space value', 'quote"value', '&|^%'] })
    expect(wrapperEnvironment.REPORT_MARKER).toBe('1')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(terminateChild).not.toHaveBeenCalled()
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
  })

  it('returns the shutdown signal received during owned cleanup', async () => {
    const testRoot = createTestRoot()
    const signalSource = new EventEmitter()

    const result = await runHeavyTestSuite({
      suite: 'fixture',
      steps: [],
      tempDir: testRoot,
      signalSource,
      cleanupRun: async () => {
        signalSource.emit('SIGHUP')
      }
    })

    expect(result).toBe(129)
    expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
  })

  it('targets only the owned POSIX process group or exact Windows child tree', () => {
    const killProcess = vi.fn()
    terminateChildTree(4321, 'SIGTERM', { platform: 'darwin', killProcess })
    expect(killProcess).toHaveBeenCalledWith(-4321, 'SIGTERM')

    const unref = vi.fn()
    const taskkill = new EventEmitter()
    taskkill.unref = unref
    const spawnProcess = vi.fn(() => taskkill)
    const onError = vi.fn()
    terminateChildTree(9876, 'SIGTERM', {
      platform: 'win32',
      spawnProcess,
      onError
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '9876', '/t', '/f'],
      expect.objectContaining({ windowsHide: true })
    )
    expect(unref).toHaveBeenCalled()
    const taskkillError = new Error('taskkill unavailable')
    taskkill.emit('error', taskkillError)
    expect(onError).toHaveBeenCalledWith(taskkillError)
  })

  it('removes a package-manager delimiter while preserving suite arguments', () => {
    expect(normalizeForwardedArgs(['--', 'src/example.test.ts', '--bail=1'])).toEqual([
      'src/example.test.ts',
      '--bail=1'
    ])
    expect(normalizeForwardedArgs(['--project=electron-headless'])).toEqual([
      '--project=electron-headless'
    ])
    expect(normalizeForwardedArgs(['--project=electron-headless', '--', '--list'])).toEqual([
      '--project=electron-headless',
      '--list'
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a second suite across working directories and cleans up after SIGTERM',
    async () => {
      const testRoot = createTestRoot()
      const firstCwd = path.join(testRoot, 'first-cwd')
      const secondCwd = path.join(testRoot, 'second-cwd')
      const firstReady = path.join(testRoot, 'first-ready')
      const secondReady = path.join(testRoot, 'second-ready')
      const signalMarker = path.join(testRoot, 'signal-marker')
      mkdirSync(firstCwd)
      mkdirSync(secondCwd)
      const isolatedEnv = {
        ...process.env,
        TMPDIR: testRoot,
        TMP: testRoot,
        TEMP: testRoot
      }
      const first = spawn(process.execPath, [fixturePath, 'runner', firstReady, signalMarker], {
        cwd: firstCwd,
        env: isolatedEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      spawnedProcesses.add(first)
      await waitForFile(firstReady)

      const startedAt = Date.now()
      const second = spawn(
        process.execPath,
        [fixturePath, 'runner', secondReady, path.join(testRoot, 'second-signal')],
        { cwd: secondCwd, env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      spawnedProcesses.add(second)
      let secondStderr = ''
      second.stderr?.on('data', (chunk) => {
        secondStderr += String(chunk)
      })
      const secondExit = await waitForExit(second)

      expect(secondExit.code).toBe(1)
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(secondStderr).toContain('already running')
      expect(existsSync(secondReady)).toBe(false)

      first.kill('SIGTERM')
      const firstExit = await waitForExit(first)
      spawnedProcesses.delete(first)
      await waitForFile(signalMarker)
      expect(firstExit.code).toBe(143)
      expect(readFileSync(signalMarker, 'utf8')).toBe('SIGTERM')
      expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
      expect(
        readdirSync(testRoot).filter((name) => /^orca-e2e-(?:run|repo|worktree)-/.test(name))
      ).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the report gate as the admission owner and cleans up after SIGTERM',
    async () => {
      const testRoot = createTestRoot()
      const readyFile = path.join(testRoot, 'report-ready')
      const signalMarker = path.join(testRoot, 'report-signal')
      const isolatedEnv = {
        ...process.env,
        TMPDIR: testRoot,
        TMP: testRoot,
        TEMP: testRoot
      }
      const reportOwner = spawn(
        process.execPath,
        [fixturePath, 'report-owner', readyFile, signalMarker],
        { cwd: testRoot, env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      spawnedProcesses.add(reportOwner)
      await waitForFile(readyFile)

      reportOwner.kill('SIGTERM')
      const reportExit = await waitForExit(reportOwner)
      spawnedProcesses.delete(reportOwner)
      await waitForFile(signalMarker)

      expect(reportExit.code).toBe(143)
      expect(readFileSync(signalMarker, 'utf8')).toBe('SIGTERM')
      expect(existsSync(getHeavySuiteLockPath(testRoot))).toBe(false)
      expect(
        readdirSync(testRoot).filter((name) => /^orca-e2e-(?:run|repo|worktree)-/.test(name))
      ).toEqual([])
    }
  )

  it('resolves specialized Electron suites without an intermediate process wrapper', () => {
    const baseEnv = { PATH: process.env.PATH, ORCA_TEST_MARKER: '1' }
    const terminalScale = resolveSuitePlan('electron-e2e-terminal-scale', ['--grep', 'scale'], {
      env: baseEnv
    })
    expect(terminalScale.steps[1].args).toEqual(
      expect.arrayContaining([
        'tests/e2e/artificial-opencode-terminal-load.spec.ts',
        '--workers=1',
        '--grep',
        'scale'
      ])
    )
    expect(terminalScale.steps[1].env.ORCA_E2E_OPENCODE_SCALE_PANES).toBe('10,25,50,100')

    const typing = resolveSuitePlan(
      'electron-e2e-multi-workspace-typing',
      ['--panes', '8', '--grep', 'typing'],
      { env: baseEnv }
    )
    expect(typing.steps[1].env).toMatchObject({
      ORCA_TYPING_BENCH: '1',
      ORCA_TYPING_BENCH_LOAD_PANES: '8'
    })
    expect(typing.steps[1].args).not.toContain('--panes')
    expect(typing.steps[1].args).toEqual(expect.arrayContaining(['--grep', 'typing']))

    for (const suite of [
      'electron-e2e-ssh-docker-perf',
      'electron-e2e-ssh-docker-watcher',
      'electron-e2e-ssh-codex-artifacts'
    ]) {
      expect(resolveSuitePlan(suite, [], { env: baseEnv }).steps[1].env.ORCA_E2E_SSH_DOCKER).toBe(
        '1'
      )
    }
  })

  it('wires every package-level heavy test entry point through shared admission', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    )

    expect(packageJson.scripts.test).toBe('node config/scripts/run-heavy-test-suite.mjs unit')
    expect(packageJson.scripts['test:e2e']).toBe(
      'node config/scripts/run-heavy-test-suite.mjs electron-e2e --project=electron-headless'
    )
    expect(packageJson.scripts['test:e2e:headful']).toBe(
      'node config/scripts/run-heavy-test-suite.mjs electron-e2e --project=electron-headful'
    )
    for (const scriptName of [
      'test:e2e:floating-mobile-emulator',
      'test:e2e:terminal-rendering-golden',
      'test:e2e:terminal-rendering-release-evidence',
      'test:e2e:terminal-perf',
      'test:e2e:source-control-scale'
    ]) {
      expect(packageJson.scripts[scriptName], scriptName).toContain(
        'node config/scripts/run-heavy-test-suite.mjs electron-e2e'
      )
    }
    expect(packageJson.scripts['test:e2e:computer']).toBe(
      'node config/scripts/run-heavy-test-suite.mjs computer-e2e'
    )

    for (const scriptName of [
      'test:e2e:terminal-perf:scale',
      'test:e2e:ssh-docker-perf',
      'test:e2e:ssh-docker-watcher-isolation',
      'test:e2e:ssh-codex-artifacts-repro',
      'bench:multi-workspace-typing'
    ]) {
      expect(packageJson.scripts[scriptName], scriptName).toContain(
        'node config/scripts/run-heavy-test-suite.mjs electron-e2e-'
      )
    }

    const directBypasses = Object.entries(packageJson.scripts).filter(
      ([scriptName, command]) =>
        (scriptName.startsWith('test') || scriptName === 'bench:multi-workspace-typing') &&
        (/\bnpx playwright\b/.test(command) ||
          /\bpnpm exec playwright\b/.test(command) ||
          /\bvitest run\b/.test(command))
    )
    expect(directBypasses).toEqual([])
  })
})
