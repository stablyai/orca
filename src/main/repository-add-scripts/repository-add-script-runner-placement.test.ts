import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import type { RepositoryAddScriptRun } from './repository-add-script-service'
import { createRepositoryAddScriptRunner } from './repository-add-script-runner'

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
const always = (): boolean => true

function windowsRun(path: string): RepositoryAddScriptRun {
  return {
    hostId: 'local',
    repoId: 'repo-1',
    path,
    target: { kind: 'native', cwd: path },
    script: 'echo hi'
  }
}

function build() {
  const createTempRoot = vi.fn((): string => {
    throw new Error('temp preparation must not start')
  })
  const runProcess = vi.fn(async (_spec: ProcessSpec): Promise<ProcessResult> => ({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  }))
  const runWslProcess = vi.fn(async (_spec: WslSpec): Promise<WslResult> => ({
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false
  }))
  const runner = createRepositoryAddScriptRunner({
    getExecutorHostId: () => 'local',
    getRuntime: () => WINDOWS_HOST,
    platform: 'win32',
    createTempRoot,
    runProcess,
    runWslProcess
  })
  return { runner, createTempRoot, runProcess, runWslProcess }
}

describe('native Windows placement', () => {
  it.each([
    ['a root-relative path', '\\foo'],
    ['a forward-slash root path', '/foo'],
    ['a drive-relative path', 'C:foo'],
    ['a network share', '\\\\server\\share\\repo'],
    ['a verbatim device path', '\\\\?\\C:\\repo'],
    ['a device namespace path', '\\\\.\\x']
  ])('refuses %s before any preparation or spawn', async (_name, path) => {
    const state = build()
    await expect(state.runner(windowsRun(path), always)).rejects.toThrow()
    expect(state.createTempRoot).not.toHaveBeenCalled()
    expect(state.runProcess).not.toHaveBeenCalled()
    expect(state.runWslProcess).not.toHaveBeenCalled()
  })

  it('runs in a drive-absolute cwd containing spaces', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'add-script-placement-'))
    try {
      const state = build()
      state.createTempRoot.mockReturnValue(tempRoot)
      const path = 'C:\\My Repos\\repo one'
      expect(await state.runner(windowsRun(path), always)).toMatchObject({ exitCode: 0 })
      expect(state.runProcess).toHaveBeenCalledOnce()
      expect(state.runProcess.mock.calls[0][0].cwd).toBe(path)
      expect(readdirSync(tempRoot)).toEqual([])
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
