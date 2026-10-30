import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock, blockedForExecMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  blockedForExecMock: vi.fn(async (): Promise<{ distro: string; state: string } | null> => null)
}))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('../wsl/wsl-background-exec-gate', () => ({
  blockedWslDistroForExec: blockedForExecMock
}))

import {
  MAX_WSL_CANONICAL_PATH_CACHE_ENTRIES,
  _internals,
  createCodexWslRuntimeHookInstallPlan
} from './codex-wsl-hook-install-plan'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

type PendingRun = { spec: { program: string; args: string[] }; resolve: (r: ProcessResult) => void }
const pending: PendingRun[] = []

function exited(stdout: string, code = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

async function spawned(count: number): Promise<void> {
  await vi.waitFor(() => expect(pending).toHaveLength(count))
}

/** Answers the `index`th wsl.exe run and lets its settlement land. */
async function answer(index: number, result: ProcessResult): Promise<void> {
  pending[index].resolve(result)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  pending.length = 0
  runProcessMock.mockReset()
  runProcessMock.mockImplementation(
    (spec: PendingRun['spec']) =>
      new Promise<ProcessResult>((resolve) => pending.push({ spec, resolve }))
  )
  blockedForExecMock.mockReset()
  blockedForExecMock.mockResolvedValue(null)
  _internals.resetWslCanonicalPathCache()
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('canonicalizeWslLinuxPath', () => {
  it('bounds successful canonical path entries', async () => {
    setPlatform('win32')
    runProcessMock.mockImplementation(async () => exited('/home/canonical\n'))

    for (let index = 0; index < MAX_WSL_CANONICAL_PATH_CACHE_ENTRIES + 4; index += 1) {
      _internals.canonicalizeWslLinuxPath('Ubuntu', `/home/path-${index}`)
    }

    await vi.waitFor(() =>
      expect(_internals.getWslCanonicalPathCacheSizeForTests()).toBe(
        MAX_WSL_CANONICAL_PATH_CACHE_ENTRIES
      )
    )
  })

  it('joins guest paths without producing a double slash at the filesystem root', () => {
    const plan = createCodexWslRuntimeHookInstallPlan(
      'C:\\runtime',
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      () => '/'
    )

    expect(plan?.commandScriptPath).toBe('/.orca/agent-hooks/codex-hook.sh')
    expect(plan?.trustConfigPath).toBe('/hooks.json')
  })

  it('returns the path unchanged off Windows without spawning wsl.exe', async () => {
    setPlatform('linux')
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alice')).toBe('/home/alice')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('never blocks: returns null and schedules an async resolution through process-host', async () => {
    setPlatform('win32')
    const result = _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')

    expect(result).toBeNull()
    await spawned(1)
    expect(pending[0].spec).toMatchObject({
      program: 'wsl.exe',
      timeoutMs: 5000,
      args: [
        '-d',
        'Ubuntu',
        '--exec',
        'sh',
        '-c',
        `if [ ! -d "$1" ]; then printf '%s\\n' '__ORCA_WSL_PATH_MISSING__'; exit 0; fi; readlink -f -- "$1"`,
        'sh',
        '/home/alias'
      ]
    })
  })

  it('does not start a stopped distro to probe its Codex home, and keeps the known identity (E9)', async () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    await spawned(1)
    await answer(0, exited('/home/alice\n'))

    blockedForExecMock.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    const settled = vi.fn()
    expect(
      _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias', '/home/alias', settled)
    ).toBe('/home/alice')
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ status: 'unavailable' }))
    expect(blockedForExecMock).toHaveBeenCalledWith('Ubuntu')
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice')
  })

  it('returns the cached path while revalidating it asynchronously', async () => {
    setPlatform('win32')
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
    await spawned(1)
    await answer(0, exited('/home/alice\n'))

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice')
    await spawned(2)
  })

  it('resolves a custom automount root and notifies the first launch', async () => {
    setPlatform('win32')
    const settled = vi.fn()
    const windowsPath = 'D:\\orca\\codex-runtime-home\\home'

    expect(
      _internals.canonicalizeWslLinuxPath(
        'Ubuntu',
        '/mnt/d/orca/codex-runtime-home/home',
        windowsPath,
        settled
      )
    ).toBeNull()

    await spawned(1)
    expect(pending[0].spec).toMatchObject({
      program: 'wsl.exe',
      timeoutMs: 5000,
      args: [
        '-d',
        'Ubuntu',
        '--exec',
        'sh',
        '-c',
        `resolved=$(wslpath -a -u "$1") || exit; if [ ! -d "$resolved" ]; then printf '%s\\n' '__ORCA_WSL_PATH_MISSING__'; exit 0; fi; readlink -f -- "$resolved"`,
        'sh',
        windowsPath
      ]
    })

    await answer(0, exited('/windows/d/orca/codex-runtime-home/home\n'))
    expect(settled).toHaveBeenCalledWith({
      status: 'resolved',
      canonicalPath: '/windows/d/orca/codex-runtime-home/home'
    })
  })

  it('does not spawn a second subprocess while one is in flight', async () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')

    await spawned(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed resolution rather than caching the failure', async () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    await spawned(1)
    await answer(0, exited('', 1))

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
    await spawned(2)
  })

  it('keeps the last known-good cache when revalidation later fails', async () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    await spawned(1)
    await answer(0, exited('/home/alice\n'))

    const settled = vi.fn()
    expect(
      _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias', '/home/alias', settled)
    ).toBe('/home/alice')
    await spawned(2)
    await answer(1, exited('', 1))

    // Transport failure cannot invalidate a known-good custom-automount identity.
    expect(settled).toHaveBeenCalledWith({ status: 'unavailable' })
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice')
  })

  it('drops the cached identity when WSL confirms the path is missing', async () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    await spawned(1)
    await answer(0, exited('/home/alice\n'))

    const settled = vi.fn()
    expect(
      _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias', '/home/alias', settled)
    ).toBe('/home/alice')
    await spawned(2)
    await answer(1, exited('__ORCA_WSL_PATH_MISSING__\n'))

    expect(settled).toHaveBeenCalledWith({ status: 'missing' })
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
  })

  it('replaces a cached path when its canonical identity changes', async () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    await spawned(1)
    await answer(0, exited('/home/alice-old\n'))

    const settled = vi.fn()
    expect(
      _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias', '/home/alias', settled)
    ).toBe('/home/alice-old')
    await spawned(2)
    await answer(1, exited('/home/alice-new\n'))

    expect(settled).toHaveBeenCalledWith({
      status: 'resolved',
      canonicalPath: '/home/alice-new'
    })
    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBe('/home/alice-new')
  })

  it('ignores non-absolute readlink output', async () => {
    setPlatform('win32')
    _internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')
    await spawned(1)
    await answer(0, exited('readlink: missing operand\n'))

    expect(_internals.canonicalizeWslLinuxPath('Ubuntu', '/home/alias')).toBeNull()
  })
})
