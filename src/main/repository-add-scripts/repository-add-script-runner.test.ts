import { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProcessResult,
  ProcessSpec,
  ProcessTerminationBarrier
} from '@orca/process-host/process-spec'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { UNRESOLVED_OWNER_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../../shared/terminal-git-credential-guard'
import { buildPosixRunnerScript, buildWindowsRunnerScript } from '../setup-runner-script-text'
import type { WslGuestTermination, WslSpec } from '../wsl/wsl-runner'
import { HOOK_TIMEOUT } from '../hooks'
import {
  RepositoryAddScriptService,
  type RepositoryAddScriptRun
} from './repository-add-script-service'
import {
  createRepositoryAddScriptRunner,
  type RepositoryAddScriptRunnerDependencies
} from './repository-add-script-runner'
import { resolveRepositoryAddScriptTarget } from './repository-add-script-target'

let tempRoot: string
let workDir: string

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'add-script-test-root-'))
  workDir = mkdtempSync(join(tmpdir(), 'add-script-test-work-'))
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

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

function wslRuntime(distro: string): ProjectExecutionRuntimeResolution {
  return {
    status: 'resolved',
    runtime: {
      kind: 'wsl',
      hostPlatform: 'wsl',
      projectId: 'repo-1',
      distro,
      reason: 'project-override',
      cacheKey: 'k'
    }
  }
}

// Windows never defaults to native, so Windows fixtures name the resolved host runtime.
function hostRuntime(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? WINDOWS_HOST : undefined
}

function makeRun(overrides: Partial<RepositoryAddScriptRun> = {}): RepositoryAddScriptRun {
  const path = overrides.path ?? workDir
  return {
    hostId: 'local',
    repoId: 'repo-1',
    path,
    target: { kind: 'native', cwd: path },
    script: 'echo hi',
    ...overrides
  }
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function build(overrides: Partial<RepositoryAddScriptRunnerDependencies> = {}) {
  const spawned: ProcessSpec[] = []
  const snapshots: string[] = []
  const runProcess = vi.fn(async (spec: ProcessSpec) => {
    spawned.push(spec)
    snapshots.push(readFileSync(spec.args?.[0] ?? spec.program, 'utf-8'))
    return processResult()
  })
  const runner = createRepositoryAddScriptRunner({
    getRuntime: () => hostRuntime(overrides.platform),
    getExecutorHostId: () => 'local',
    createTempRoot: () => tempRoot,
    runProcess,
    ...overrides
  })
  return { runner, runProcess, spawned, snapshots }
}

const always = (): boolean => true

describe('native shell execution', () => {
  it.skipIf(process.platform === 'win32')(
    'really runs a harmless script: stdout, stderr, cwd, env, exit 0, temp removed',
    async () => {
      const runner = createRepositoryAddScriptRunner({
        getRuntime: () => hostRuntime(),
        getExecutorHostId: () => 'local',
        createTempRoot: () => tempRoot
      })
      const result = await runner(
        makeRun({ script: 'echo out\necho err >&2\npwd -P\necho "$ORCA_ROOT_PATH"' }),
        always
      )
      expect(result.exitCode).toBe(0)
      expect(result.outputTruncated).toBe(false)
      expect(result.output).toContain('out')
      expect(result.output).toContain('err')
      expect(result.output).toContain(workDir.replace(/^\/private/, ''))
      expect(readdirSync(tempRoot)).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')('reports a genuine non-zero exit', async () => {
    const runner = createRepositoryAddScriptRunner({
      getRuntime: () => hostRuntime(),
      getExecutorHostId: () => 'local',
      createTempRoot: () => tempRoot
    })
    const result = await runner(makeRun({ script: 'echo nope >&2\nexit 7' }), always)
    expect(result).toMatchObject({ exitCode: 7 })
    expect(result.output).toContain('nope')
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('runs the shared posix runner text under bash with bounded, tree-terminated limits', async () => {
    const { runner, spawned, snapshots } = build({ platform: 'linux' })
    await runner(makeRun({ script: '#!/bin/bash -eu\nls' }), always)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      program: '/bin/bash',
      cwd: workDir,
      timeoutMs: HOOK_TIMEOUT,
      terminationBarrier: { signal: expect.any(Function), force: expect.any(Function) }
    })
    expect(spawned[0].maxOutputBytes).toBeGreaterThan(0)
    expect(spawned[0].args?.[0].startsWith(tempRoot)).toBe(true)
    expect(snapshots[0]).toBe(buildPosixRunnerScript('#!/bin/bash -eu\nls'))
    expect(spawned[0].env?.ORCA_ROOT_PATH).toBe(workDir)
    expect(spawned[0].env?.ORCA_WORKTREE_PATH).toBe(workDir)
    expect(spawned[0].env?.[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]).toBe('guard')
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('never reports an exit code for a timeout, even when the process says 0', async () => {
    const { runner, runProcess } = build()
    runProcess.mockResolvedValue(processResult({ code: 0, timedOut: true, stdout: 'partial' }))
    const result = await runner(makeRun(), always)
    expect('exitCode' in result).toBe(false)
    expect(result.output).toContain('partial')
    expect(result.output).toContain('timed out')
  })

  it.each([
    [{ code: null, signal: 'SIGKILL' as const }],
    [{ code: 0, signal: 'SIGTERM' as const }]
  ])('never reports an exit code for a signalled process %j', async (overrides) => {
    const { runner, runProcess } = build()
    runProcess.mockResolvedValue(processResult(overrides))
    const result = await runner(makeRun(), always)
    expect('exitCode' in result).toBe(false)
  })

  it('keeps both streams, clips each, and preserves upstream truncation', async () => {
    const { runner, runProcess } = build()
    runProcess.mockResolvedValue(
      processResult({ stdout: 'o'.repeat(50_000), stderr: 'e-tail', outputTruncated: true })
    )
    const result = await runner(makeRun(), always)
    expect(result.outputTruncated).toBe(true)
    expect(result.output).toContain('e-tail')
    expect(result.output.length).toBeLessThanOrEqual(16_384)

    runProcess.mockResolvedValue(processResult({ stdout: 'o'.repeat(9_000), stderr: 'e' }))
    const clipped = await runner(makeRun(), always)
    expect(clipped.outputTruncated).toBe(true)
    expect(clipped.output.length).toBeLessThanOrEqual(16_384)
  })

  it('does not retry a failed run', async () => {
    const { runner, runProcess } = build()
    runProcess.mockResolvedValue(processResult({ code: 1 }))
    await runner(makeRun(), always)
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('removes the temp directory when the spawn throws', async () => {
    const { runner, runProcess } = build()
    runProcess.mockRejectedValue(new Error('spawn failed'))
    await expect(runner(makeRun(), always)).rejects.toThrow('spawn failed')
    expect(readdirSync(tempRoot)).toEqual([])
  })
})

describe('Windows routing (mocked platform)', () => {
  const windowsRun = (script: string) => makeRun({ path: 'C:\\repo', script })

  it('runs a plain script through the cmd runner regardless of any terminal shell', async () => {
    const { runner, spawned, snapshots } = build({ platform: 'win32' })
    await runner(windowsRun('echo hi\nexit /b 3'), always)
    expect(spawned[0].program.endsWith('runner.cmd')).toBe(true)
    expect(spawned[0].args).toEqual([])
    expect(spawned[0].cwd).toBe('C:\\repo')
    expect(typeof spawned[0].terminationBarrier).toBe('object')
    expect(snapshots[0]).toBe(buildWindowsRunnerScript('echo hi\nexit /b 3'))
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('sends an explicit POSIX shebang through resolved Git Bash', async () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    const { runner, spawned, snapshots } = build({
      platform: 'win32',
      resolveGitBashPath: () => gitBash
    })
    await runner(windowsRun('#!/bin/bash\necho hi'), always)
    expect(spawned[0].program).toBe(gitBash)
    expect(spawned[0].args).toHaveLength(1)
    expect(spawned[0].args?.[0].endsWith('runner.sh')).toBe(true)
    expect(snapshots[0]).toBe(buildPosixRunnerScript('#!/bin/bash\necho hi'))
  })

  it('fails closed without spawning or writing when Git Bash is missing', async () => {
    const { runner, runProcess } = build({ platform: 'win32', resolveGitBashPath: () => null })
    await expect(runner(windowsRun('#!/bin/bash\necho hi'), always)).rejects.toThrow('Git Bash')
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it.each(['win32', 'linux', 'darwin'] as const)(
    'rejects an unsupported interpreter on %s before touching disk',
    async (platform) => {
      const { runner, runProcess } = build({
        platform,
        resolveGitBashPath: () => 'C:\\git\\bash.exe'
      })
      const path = platform === 'win32' ? 'C:\\repo' : workDir
      await expect(
        runner(makeRun({ path, script: '#!/usr/bin/env python3\nprint(1)' }), always)
      ).rejects.toThrow('unsupported interpreter')
      expect(runProcess).not.toHaveBeenCalled()
      expect(readdirSync(tempRoot)).toEqual([])
    }
  )
})

describe('owner and target guards', () => {
  it.each<ExecutionHostId>(['ssh:target-1', 'runtime:env-1', UNRESOLVED_OWNER_HOST_ID])(
    'never executes a foreign or unresolved owner (%s)',
    async (hostId) => {
      const { runner, runProcess } = build()
      await expect(runner(makeRun({ hostId }), always)).rejects.toThrow()
      expect(runProcess).not.toHaveBeenCalled()
      expect(readdirSync(tempRoot)).toEqual([])
    }
  )

  it('rejects a relative path and an empty script', async () => {
    const { runner, runProcess } = build({ platform: 'linux' })
    await expect(runner(makeRun({ path: 'relative/repo' }), always)).rejects.toThrow()
    await expect(runner(makeRun({ script: '  \n' }), always)).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('rejects a repair-required runtime instead of falling back to the native host', async () => {
    const repair: ProjectExecutionRuntimeResolution = {
      status: 'repair-required',
      repair: {
        projectId: 'repo-1',
        preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
        reason: 'wsl-distro-missing',
        source: 'project-override',
        cacheKey: 'k'
      }
    }
    const runWslProcess = vi.fn()
    const { runner, runProcess } = build({
      platform: 'win32',
      getRuntime: () => repair,
      runWslProcess
    })
    await expect(runner(makeRun({ path: 'C:\\repo' }), always)).rejects.toThrow('repair')
    expect(runProcess).not.toHaveBeenCalled()
    expect(runWslProcess).not.toHaveBeenCalled()
  })

  it('refuses a WSL target off Windows and a WSL runtime with no usable distro', async () => {
    const runWslProcess = vi.fn()
    const mac = build({
      platform: 'darwin',
      getRuntime: () => wslRuntime('Ubuntu'),
      runWslProcess
    })
    await expect(mac.runner(makeRun(), always)).rejects.toThrow()
    const resolved: ProjectExecutionRuntimeResolution = {
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'repo-1',
        distro: ' ',
        reason: 'project-override',
        cacheKey: 'k'
      }
    }
    const win = build({ platform: 'win32', getRuntime: () => resolved, runWslProcess })
    await expect(win.runner(makeRun({ path: 'C:\\repo' }), always)).rejects.toThrow()
    expect(mac.runProcess).not.toHaveBeenCalled()
    expect(win.runProcess).not.toHaveBeenCalled()
    expect(runWslProcess).not.toHaveBeenCalled()
  })

  it('rejects when the execution target changes during preparation', async () => {
    let runtime: ProjectExecutionRuntimeResolution | undefined
    const { runner, runProcess } = build({ platform: 'linux', getRuntime: () => runtime })
    const run = makeRun()
    const pending = runner(run, always)
    runtime = wslRuntime('Ubuntu')
    await expect(pending).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('refuses a run whose approved target differs from the one it resolves now', async () => {
    const runWslProcess = vi.fn()
    const { runner, runProcess } = build({ platform: 'linux', runWslProcess })
    await expect(
      runner(makeRun({ target: { kind: 'native', cwd: '/elsewhere' } }), always)
    ).rejects.toThrow('target')
    await expect(
      runner(makeRun({ target: { kind: 'wsl', distro: 'Ubuntu', cwd: workDir } }), always)
    ).rejects.toThrow('target')
    expect(runProcess).not.toHaveBeenCalled()
    expect(runWslProcess).not.toHaveBeenCalled()
  })

  it('refuses an unresolved Windows runtime instead of defaulting to native', async () => {
    const { runner, runProcess } = build({ platform: 'win32', getRuntime: () => undefined })
    await expect(runner(makeRun({ path: 'C:\\repo' }), always)).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
  })
})

describe('WSL execution', () => {
  // The WSL path helpers read the real process.platform, so stub it for this block only.
  const realPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  const wslPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
  const wslTarget = { kind: 'wsl', distro: 'Ubuntu', cwd: '/home/me/repo' } as const

  function buildWsl(
    runWslProcess: (
      spec: WslSpec
    ) => ReturnType<NonNullable<RepositoryAddScriptRunnerDependencies['runWslProcess']>>
  ) {
    return build({ platform: 'win32', runWslProcess })
  }

  it('runs through the shared WSL runner with the Linux cwd and converted env, never natively', async () => {
    const seen: WslSpec[] = []
    const { runner, runProcess } = buildWsl(async (spec) => {
      seen.push(spec)
      return { environmentResolved: true, code: 0, stdout: 'ok', stderr: '', timedOut: false }
    })
    const result = await runner(
      makeRun({ path: wslPath, target: wslTarget, script: 'echo hi' }),
      always
    )
    expect(result).toMatchObject({ exitCode: 0, output: 'ok' })
    expect(runProcess).not.toHaveBeenCalled()
    expect(seen[0]).toMatchObject({
      distro: 'Ubuntu',
      cwd: '/home/me/repo',
      shell: 'bash',
      loginPath: 'preferred',
      timeoutMs: HOOK_TIMEOUT,
      script: buildPosixRunnerScript('echo hi')
    })
    expect(seen[0].guestTermination?.wrapGuestArgs(['x'])[2]).toContain('unsupported')
    expect(seen[0].env?.ORCA_ROOT_PATH).toBe('/home/me/repo')
    expect(seen[0].env?.[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]).toBe('guard')
    expect(typeof seen[0].beforeSpawn).toBe('function')
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('routes a project-runtime WSL target for a Windows-form path', async () => {
    const seen: WslSpec[] = []
    const { runner } = build({
      platform: 'win32',
      getRuntime: () => wslRuntime('Debian'),
      runWslProcess: async (spec) => {
        seen.push(spec)
        return { environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false }
      }
    })
    await runner(
      makeRun({ path: 'C:\\repo', target: { kind: 'wsl', distro: 'Debian', cwd: '/mnt/c/repo' } }),
      always
    )
    expect(seen[0]).toMatchObject({ distro: 'Debian', cwd: '/mnt/c/repo' })
  })

  it('maps a WSL timeout to a missing exit code and keeps truncation', async () => {
    const { runner } = buildWsl(async () => ({
      environmentResolved: true,
      code: 0,
      stdout: 'a',
      stderr: 'b',
      timedOut: true,
      outputTruncated: true
    }))
    const result = await runner(makeRun({ path: wslPath, target: wslTarget }), always)
    expect('exitCode' in result).toBe(false)
    expect(result.outputTruncated).toBe(true)
    expect(result.output).toContain('a\nb')
  })

  it('blocks the spawn when approval is revoked during the awaited environment probe', async () => {
    let authorized = true
    let spawned = false
    const { runner } = buildWsl(async (spec) => {
      await Promise.resolve()
      authorized = false
      spec.beforeSpawn?.()
      spawned = true
      return { environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false }
    })
    await expect(
      runner(makeRun({ path: wslPath, target: wslTarget }), () => authorized)
    ).rejects.toThrow()
    expect(spawned).toBe(false)
  })

  it('does not fall back to native when the WSL runner cannot start', async () => {
    const { runner, runProcess } = buildWsl(async () => {
      throw new Error('wsl.exe missing')
    })
    await expect(runner(makeRun({ path: wslPath, target: wslTarget }), always)).rejects.toThrow(
      'wsl.exe missing'
    )
    expect(runProcess).not.toHaveBeenCalled()
  })
})

describe('executor identity', () => {
  it('executes a run owned by the runtime this process is, without rewriting it', async () => {
    const { runner, spawned } = build({ getExecutorHostId: () => 'runtime:env-1' })
    await runner(makeRun({ hostId: 'runtime:env-1' }), always)
    expect(spawned).toHaveLength(1)
  })

  it.each<[ExecutionHostId, ExecutionHostId]>([
    ['local', 'runtime:env-1'],
    ['local', 'ssh:target-1'],
    ['runtime:env-1', 'local'],
    ['runtime:env-1', 'runtime:env-2'],
    [UNRESOLVED_OWNER_HOST_ID, UNRESOLVED_OWNER_HOST_ID]
  ])('executor %s refuses a run owned by %s', async (executor, owner) => {
    const { runner, runProcess } = build({ getExecutorHostId: () => executor })
    await expect(runner(makeRun({ hostId: owner }), always)).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('refuses when the executor identity changes during preparation', async () => {
    let executor: ExecutionHostId = 'runtime:env-1'
    const { runner, runProcess } = build({ getExecutorHostId: () => executor })
    const pending = runner(makeRun({ hostId: 'runtime:env-1' }), always)
    executor = 'runtime:env-2'
    await expect(pending).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })
})

describe('strict authorization verdict', () => {
  it.each([
    ['undefined', () => undefined],
    ['1', () => 1],
    ['a resolved promise', () => Promise.resolve(true)],
    ['a rejected promise', () => Promise.reject(new Error('late'))]
  ])('only literal true authorizes (%s)', async (_name, verdict) => {
    const { runner, runProcess } = build()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Deliberately violates the type to prove the runtime guard.
    await expect(runner(makeRun(), verdict as never)).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
  })
})

describe('authorization revalidation', () => {
  it('does not spawn when approval is already stale', async () => {
    const { runner, runProcess } = build()
    await expect(runner(makeRun(), () => false)).rejects.toThrow()
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('does not spawn, and cleans up, when approval lapses after asynchronous preparation', async () => {
    let calls = 0
    const { runner, runProcess } = build()
    await expect(runner(makeRun(), () => ++calls === 1)).rejects.toThrow()
    expect(calls).toBe(2)
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('end to end: a script change during preparation yields stale and no process', async () => {
    let script = 'echo configured'
    const repo = {
      id: 'repo-1',
      path: workDir,
      displayName: 'repo',
      badgeColor: '',
      addedAt: 1,
      executionHostId: 'local' as const
    }
    const runProcess = vi.fn(async () => processResult())
    const runner = createRepositoryAddScriptRunner({
      getRuntime: () => hostRuntime(),
      getExecutorHostId: () => 'local',
      runProcess,
      createTempRoot: () => {
        script = 'echo changed'
        return tempRoot
      }
    })
    const service = new RepositoryAddScriptService({
      getOwner: () => ({ hostId: 'local', label: 'Local', available: true, supported: true }),
      getRepo: () => repo,
      repoExists: () => true,
      getScript: () => script,
      resolveTarget: (current) =>
        resolveRepositoryAddScriptTarget(current.path, hostRuntime(), process.platform),
      runScript: runner
    })
    const preview = service.offerForRegistration({ repo, disposition: 'new' })
    if (!preview) {
      throw new Error('Expected preview')
    }
    const result = await service.decide({
      token: preview.token,
      hostId: preview.hostId,
      repoId: preview.repoId,
      decision: 'run'
    })
    expect(result).toEqual({ status: 'stale' })
    expect(runProcess).not.toHaveBeenCalled()
    expect(readdirSync(tempRoot)).toEqual([])
  })
})

describe('unverified termination', () => {
  const realPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  // Drives the barrier the way process-host does on a timeout: TERM, then force.
  async function timeOutNative(
    barrier: Exclude<ProcessSpec['terminationBarrier'], boolean | undefined>
  ) {
    const child = new ChildProcess()
    await barrier.signal(child, 'SIGTERM').catch(() => false)
    await barrier.force(child).catch(() => false)
  }

  function nativeTimeout(termination: ProcessTerminationBarrier) {
    const runProcess = vi.fn(async (spec: ProcessSpec) => {
      if (typeof spec.terminationBarrier === 'object') {
        await timeOutNative(spec.terminationBarrier)
      }
      return processResult({ code: 0, timedOut: true, stdout: 'partial' })
    })
    return build({ runProcess, platform: 'linux', treeTermination: termination })
  }

  it('native: a timeout whose tree cleanup cannot be proven is unverifiable and says it may still run', async () => {
    const { runner } = nativeTimeout({ signal: async () => false, force: async () => false })
    const result = await runner(makeRun(), always)
    expect(result.processVerdict).toBe('unverifiable')
    expect('exitCode' in result).toBe(false)
    expect(result.output).toContain('partial')
    expect(result.output).toContain('may still be running')
  })

  it('native: a throwing tree terminator is unverifiable, not an exit', async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error('boom')
    }
    const { runner } = nativeTimeout({ signal: boom, force: boom })
    const result = await runner(makeRun(), always)
    expect(result.processVerdict).toBe('unverifiable')
    expect('exitCode' in result).toBe(false)
  })

  it('native: a timeout whose force cleanup is proven stays an ordinary unsuccessful run', async () => {
    const { runner } = nativeTimeout({ signal: async () => false, force: async () => true })
    const result = await runner(makeRun(), always)
    expect(result.processVerdict).toBeUndefined()
    expect('exitCode' in result).toBe(false)
    expect(result.output).toContain('timed out')
  })

  function nativeRejectsAfterBarrier(termination: ProcessTerminationBarrier) {
    const runProcess = vi.fn(async (spec: ProcessSpec) => {
      if (typeof spec.terminationBarrier === 'object') {
        await timeOutNative(spec.terminationBarrier)
      }
      throw new Error('deferred child error')
    })
    return build({ runProcess, platform: 'linux', treeTermination: termination })
  }

  it('native: a rejection after an unproven barrier is unverifiable, not an ordinary failure', async () => {
    const { runner } = nativeRejectsAfterBarrier({
      signal: async () => false,
      force: async () => false
    })
    const result = await runner(makeRun(), always)
    expect(result.processVerdict).toBe('unverifiable')
    expect('exitCode' in result).toBe(false)
    expect(result.output).toContain('may still be running')
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('native: a rejection after a throwing barrier is unverifiable', async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error('boom')
    }
    const { runner } = nativeRejectsAfterBarrier({ signal: boom, force: boom })
    const result = await runner(makeRun(), always)
    expect(result.processVerdict).toBe('unverifiable')
  })

  it('native: a rejection after proven cleanup, or with no barrier attempt, still rethrows', async () => {
    const proven = nativeRejectsAfterBarrier({ signal: async () => true, force: async () => true })
    await expect(proven.runner(makeRun(), always)).rejects.toThrow('deferred child error')
    const { runner } = build({
      platform: 'linux',
      runProcess: vi.fn(async () => {
        throw new Error('spawn failed')
      })
    })
    await expect(runner(makeRun(), always)).rejects.toThrow('spawn failed')
    expect(readdirSync(tempRoot)).toEqual([])
  })

  it('native: only an observed exit is never unverifiable', async () => {
    const { runner } = build({ platform: 'linux' })
    const result = await runner(makeRun(), always)
    expect(result.exitCode).toBe(0)
    expect(result.processVerdict).toBeUndefined()
  })

  describe('WSL', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
    })
    const wslPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    const wslTarget = { kind: 'wsl', distro: 'Ubuntu', cwd: '/home/me/repo' } as const

    function guest(results: { signal: boolean | 'throws'; force: boolean | 'throws' }) {
      const settle = async (value: boolean | 'throws') => {
        if (value === 'throws') {
          throw new Error('guest probe failed')
        }
        return value
      }
      const termination: WslGuestTermination = {
        signal: async () => settle(results.signal),
        force: async () => settle(results.force),
        wrapGuestArgs: (args) => [...args],
        stripControlOutput: (stderr) => stderr
      }
      return termination
    }

    function timeoutWsl(results: Parameters<typeof guest>[0]) {
      const createGuestTermination = () => guest(results)
      const runWslProcess = async (spec: WslSpec) => {
        const child = new ChildProcess()
        await spec.guestTermination?.signal(child, 'SIGTERM').catch(() => false)
        await spec.guestTermination?.force(child).catch(() => false)
        return {
          environmentResolved: true,
          code: 0,
          stdout: 'partial',
          stderr: '',
          timedOut: true
        }
      }
      return build({ platform: 'win32', runWslProcess, createGuestTermination })
    }

    it.each<[string, { signal: boolean | 'throws'; force: boolean | 'throws' }]>([
      ['no guest group id reported (cleanup false)', { signal: false, force: false }],
      ['guest cleanup throws', { signal: 'throws', force: 'throws' }]
    ])('a timeout with %s is unverifiable and may still run', async (_name, results) => {
      const { runner } = timeoutWsl(results)
      const result = await runner(makeRun({ path: wslPath, target: wslTarget }), always)
      expect(result.processVerdict).toBe('unverifiable')
      expect('exitCode' in result).toBe(false)
      expect(result.output).toContain('may still be running')
    })

    it('a timeout whose guest group is proven gone is unsuccessful but not unverifiable', async () => {
      const { runner } = timeoutWsl({ signal: true, force: true })
      const result = await runner(makeRun({ path: wslPath, target: wslTarget }), always)
      expect(result.processVerdict).toBeUndefined()
      expect('exitCode' in result).toBe(false)
      expect(result.output).toContain('timed out')
    })

    function wslRejectsAfterBarrier(results: Parameters<typeof guest>[0]) {
      return build({
        platform: 'win32',
        createGuestTermination: () => guest(results),
        runWslProcess: async (spec) => {
          const child = new ChildProcess()
          await spec.guestTermination?.signal(child, 'SIGTERM').catch(() => false)
          await spec.guestTermination?.force(child).catch(() => false)
          throw new Error('deferred child error')
        }
      })
    }

    it.each<[string, { signal: boolean | 'throws'; force: boolean | 'throws' }]>([
      ['false', { signal: false, force: false }],
      ['throwing', { signal: 'throws', force: 'throws' }]
    ])('a rejection after a %s guest barrier is unverifiable', async (_name, results) => {
      const { runner } = wslRejectsAfterBarrier(results)
      const result = await runner(makeRun({ path: wslPath, target: wslTarget }), always)
      expect(result.processVerdict).toBe('unverifiable')
      expect('exitCode' in result).toBe(false)
      expect(result.output).toContain('may still be running')
    })

    it('a rejection after proven guest cleanup, or with no barrier attempt, still rethrows', async () => {
      const { runner } = wslRejectsAfterBarrier({ signal: true, force: true })
      await expect(runner(makeRun({ path: wslPath, target: wslTarget }), always)).rejects.toThrow(
        'deferred'
      )
    })

    it('a normal observed exit is untouched by the guest verdict', async () => {
      const { runner } = build({
        platform: 'win32',
        createGuestTermination: () => guest({ signal: false, force: false }),
        runWslProcess: async () => ({
          environmentResolved: true,
          code: 3,
          stdout: '',
          stderr: '',
          timedOut: false
        })
      })
      const result = await runner(makeRun({ path: wslPath, target: wslTarget }), always)
      expect(result).toMatchObject({ exitCode: 3 })
      expect(result.processVerdict).toBeUndefined()
    })

    it('propagates a launch refusal as a thrown error, never as an exit', async () => {
      const { runner } = build({
        platform: 'win32',
        runWslProcess: async () => {
          throw new Error('WSL guest cannot isolate a process group; the command was not run.')
        }
      })
      await expect(runner(makeRun({ path: wslPath, target: wslTarget }), always)).rejects.toThrow(
        'not run'
      )
    })

    it('default wiring is the strict guest helper: wrapper present and refusal recognised', async () => {
      const seen: WslSpec[] = []
      const { runner } = build({
        platform: 'win32',
        runWslProcess: async (spec) => {
          seen.push(spec)
          return { environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false }
        }
      })
      await runner(makeRun({ path: wslPath, target: wslTarget }), always)
      const termination = seen[0].guestTermination
      const wrapped = termination?.wrapGuestArgs(['x']).join(' ') ?? ''
      const marker = /__ORCA_WSL_PROCESS_GROUP_[0-9a-f-]+__=/.exec(wrapped)?.[0]
      expect(marker).toBeDefined()
      expect(termination?.launchRefused?.(`${marker}unsupported\n`)).toBe(true)
      expect(termination?.launchRefused?.('setsid: unsupported')).toBe(false)
    })
  })
})
