import { ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProcessResult,
  ProcessSpec,
  ProcessTerminationBarrier
} from '@orca/process-host/process-spec'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { Repo } from '../../shared/repo-types'
import type { WslGuestTermination, WslResult, WslSpec } from '../wsl/wsl-runner'
import {
  RepositoryAddScriptService,
  type RepositoryAddScriptRun
} from './repository-add-script-service'
import {
  createRepositoryAddScriptRunner,
  type RepositoryAddScriptRunnerDependencies
} from './repository-add-script-runner'
import { resolveRepositoryAddScriptTarget } from './repository-add-script-target'

const WINDOWS_HOST: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'repo-1',
    reason: 'global-default',
    cacheKey: 'k'
  }
}
const WSL_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const WSL_TARGET = { kind: 'wsl', distro: 'Ubuntu', cwd: '/home/me/repo' } as const
const always = (): boolean => true

let tempRoot: string
let workDir: string
const realPlatform = process.platform

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'add-script-abort-root-'))
  workDir = mkdtempSync(join(tmpdir(), 'add-script-abort-work-'))
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  rmSync(tempRoot, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

function nativeRun(): RepositoryAddScriptRun {
  return {
    hostId: 'local',
    repoId: 'repo-1',
    path: workDir,
    target: { kind: 'native', cwd: workDir },
    script: 'echo hi'
  }
}

function wslRun(): RepositoryAddScriptRun {
  return { ...nativeRun(), path: WSL_PATH, target: { ...WSL_TARGET } }
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: 'out', stderr: '', timedOut: false, ...overrides }
}

function wslResult(overrides: Partial<WslResult> = {}): WslResult {
  return {
    environmentResolved: true,
    code: 0,
    stdout: 'out',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

function build(overrides: Partial<RepositoryAddScriptRunnerDependencies> = {}) {
  const runProcess = vi.fn(async (_spec: ProcessSpec) => processResult())
  const runWslProcess = vi.fn(async (_spec: WslSpec) => wslResult())
  const runner = createRepositoryAddScriptRunner({
    getExecutorHostId: () => 'local',
    getRuntime: () => undefined,
    platform: 'linux',
    createTempRoot: () => tempRoot,
    runProcess,
    runWslProcess,
    ...overrides
  })
  return { runner, runProcess, runWslProcess }
}

function barrier(proven: boolean): ProcessTerminationBarrier {
  return { signal: async () => proven, force: async () => proven }
}

function guest(proven: boolean): WslGuestTermination {
  return {
    ...barrier(proven),
    wrapGuestArgs: (args) => [...args],
    stripControlOutput: (stderr) => stderr
  }
}

// Drives the barrier the way process-host does when its abort signal fires.
async function stopVia(termination: ProcessTerminationBarrier | undefined | boolean) {
  if (typeof termination === 'object') {
    const child = new ChildProcess()
    await termination.signal(child, 'SIGTERM').catch(() => false)
    await termination.force(child).catch(() => false)
  }
}

describe('native abort', () => {
  it('never prepares or spawns when already aborted', async () => {
    const { runner, runProcess } = build()
    const controller = new AbortController()
    controller.abort()
    await expect(runner(nativeRun(), always, controller.signal)).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('never spawns when aborted while the temp runner is being written', async () => {
    const controller = new AbortController()
    const { runner, runProcess } = build({
      createTempRoot: () => {
        queueMicrotask(() => controller.abort())
        return tempRoot
      }
    })
    await expect(runner(nativeRun(), always, controller.signal)).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('passes the signal to the spawn and never reports an aborted exit 0 as an exit', async () => {
    const controller = new AbortController()
    const { runner, runProcess } = build({ treeTermination: barrier(true) })
    runProcess.mockImplementation(async (spec) => {
      expect(spec.signal).toBe(controller.signal)
      controller.abort()
      await stopVia(spec.terminationBarrier)
      return processResult({ code: 0 })
    })
    const result = await runner(nativeRun(), always, controller.signal)
    expect('exitCode' in result).toBe(false)
    expect(result.processVerdict).toBeUndefined()
    expect(result.output).toContain('stopped')
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('reports an abort whose stop was never proven as unverifiable', async () => {
    const controller = new AbortController()
    const { runner, runProcess } = build({ treeTermination: barrier(false) })
    runProcess.mockImplementation(async (spec) => {
      controller.abort()
      await stopVia(spec.terminationBarrier)
      return processResult({ code: 0 })
    })
    const result = await runner(nativeRun(), always, controller.signal)
    expect(result.processVerdict).toBe('unverifiable')
    expect('exitCode' in result).toBe(false)
    expect(result.output).toContain('may still be running')
  })

  it('treats any unproven stop attempt as unverifiable, even without a timeout or abort', async () => {
    const { runner, runProcess } = build({ treeTermination: barrier(false) })
    runProcess.mockImplementation(async (spec) => {
      await stopVia(spec.terminationBarrier)
      return processResult({ code: null, signal: 'SIGKILL' })
    })
    expect((await runner(nativeRun(), always)).processVerdict).toBe('unverifiable')
  })

  it('reports a rejection after a proven aborted stop as a stopped run, not a throw', async () => {
    const controller = new AbortController()
    const { runner, runProcess } = build({ treeTermination: barrier(true) })
    runProcess.mockImplementation(async (spec) => {
      controller.abort()
      await stopVia(spec.terminationBarrier)
      throw new Error('deferred child error')
    })
    const result = await runner(nativeRun(), always, controller.signal)
    expect('exitCode' in result).toBe(false)
    expect(result.processVerdict).toBeUndefined()
  })

  it('leaves an unaborted exit 0 a success', async () => {
    const { runner } = build()
    expect(await runner(nativeRun(), always, new AbortController().signal)).toMatchObject({
      exitCode: 0
    })
  })
})

describe('WSL abort', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  function buildWsl(proven = true, overrides: Partial<RepositoryAddScriptRunnerDependencies> = {}) {
    return build({
      platform: 'win32',
      getRuntime: () => WINDOWS_HOST,
      createGuestTermination: () => guest(proven),
      ...overrides
    })
  }

  it('never launches when already aborted', async () => {
    const { runner, runWslProcess, runProcess } = buildWsl()
    const controller = new AbortController()
    controller.abort()
    await expect(runner(wslRun(), always, controller.signal)).rejects.toThrow()
    expect(runWslProcess).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('passes the signal and refuses the spawn when aborted during the environment probe', async () => {
    const controller = new AbortController()
    let spawned = false
    const { runner, runWslProcess } = buildWsl()
    runWslProcess.mockImplementation(async (spec) => {
      expect(spec.signal).toBe(controller.signal)
      await Promise.resolve()
      controller.abort()
      spec.beforeSpawn?.()
      spawned = true
      return wslResult()
    })
    await expect(runner(wslRun(), always, controller.signal)).rejects.toThrow()
    expect(spawned).toBe(false)
  })

  it.each([
    [true, undefined],
    [false, 'unverifiable']
  ] as const)(
    'an abort after launch with proven=%s stop is never an exit',
    async (proven, verdict) => {
      const controller = new AbortController()
      const { runner, runWslProcess } = buildWsl(proven)
      runWslProcess.mockImplementation(async (spec) => {
        controller.abort()
        await stopVia(spec.guestTermination)
        return wslResult({ code: 0 })
      })
      const result = await runner(wslRun(), always, controller.signal)
      expect('exitCode' in result).toBe(false)
      expect(result.processVerdict).toBe(verdict)
    }
  )
})

describe('service close during runner preparation', () => {
  function compose(overrides: Partial<RepositoryAddScriptRunnerDependencies>) {
    const platform = overrides.platform ?? 'linux'
    const runtime = platform === 'win32' ? WINDOWS_HOST : undefined
    const path = platform === 'win32' ? WSL_PATH : workDir
    const repo: Repo = { id: 'repo-1', path, displayName: 'r', badgeColor: '', addedAt: 1 }
    const built = build({ getRuntime: () => runtime, ...overrides })
    const service = new RepositoryAddScriptService({
      getOwner: (hostId) => ({ hostId, label: 'Local', available: true, supported: true }),
      getRepo: () => repo,
      repoExists: () => true,
      getScript: () => 'echo configured',
      resolveTarget: (current) => resolveRepositoryAddScriptTarget(current.path, runtime, platform),
      runScript: built.runner
    })
    const preview = service.offerForRegistration({ repo, disposition: 'new' })
    if (!preview) {
      throw new Error('Expected preview')
    }
    const decide = () =>
      service.decide({
        token: preview.token,
        hostId: preview.hostId,
        repoId: preview.repoId,
        decision: 'run'
      })
    return { ...built, service, decide }
  }

  it('native: a close while the temp runner is prepared yields stale and no process', async () => {
    let close = (): void => {}
    const state = compose({
      createTempRoot: () => {
        queueMicrotask(close)
        return tempRoot
      }
    })
    close = () => void state.service.close()
    expect(await state.decide()).toEqual({ status: 'stale' })
    expect(state.runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('WSL: a close during the environment probe yields stale and no launch', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let spawned = false
    const state = compose({ platform: 'win32', createGuestTermination: () => guest(true) })
    state.runWslProcess.mockImplementation(async (spec) => {
      await Promise.resolve()
      void state.service.close()
      spec.beforeSpawn?.()
      spawned = true
      return wslResult()
    })
    expect(await state.decide()).toEqual({ status: 'stale' })
    expect(spawned).toBe(false)
  })
})
