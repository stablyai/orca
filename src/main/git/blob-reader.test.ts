import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./runner', () => ({
  gitExecFileAsyncBuffer: vi.fn()
}))
vi.mock('./git-native-module', () => ({ loadGitNativeModule: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

import { gitExecFileAsyncBuffer } from './runner'
import { loadGitNativeModule } from './git-native-module'
import { track } from '../telemetry/client'
import {
  MAX_GIT_SHOW_BYTES,
  configureNativeGitBlobReads,
  readGitBlobRaw,
  resolveNativeGitMode,
  resetNativeGitBlobReadStateForTests
} from './blob-reader'

const mockedExec = vi.mocked(gitExecFileAsyncBuffer)
const mockedLoad = vi.mocked(loadGitNativeModule)

beforeEach(() => resetNativeGitBlobReadStateForTests())
afterEach(() => vi.clearAllMocks())

describe('readGitBlobRaw (CLI path)', () => {
  it('maps a successful git show to found bytes', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('hello') })
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'a.txt'
    })
    expect(raw).toEqual({ found: true, tooLarge: false, bytes: Buffer.from('hello') })
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', '--end-of-options', 'HEAD:a.txt'],
      expect.objectContaining({ cwd: '/repo', maxBuffer: MAX_GIT_SHOW_BYTES })
    )
  })

  it('uses the index show form for kind index', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('x') })
    await readGitBlobRaw({ kind: 'index', worktreePath: '/repo', gitPath: 'b.txt' })
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', ':b.txt'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('forwards wslDistro runtime options to the exec call', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('x') })
    await readGitBlobRaw(
      { kind: 'index', worktreePath: '/repo', gitPath: 'b.txt' },
      { wslDistro: 'Ubuntu' }
    )
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', ':b.txt'],
      expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu' })
    )
  })

  it('forwards an abort signal through runtime options to the exec call', async () => {
    mockedExec.mockResolvedValue({ stdout: Buffer.from('x') })
    const signal = new AbortController().signal
    await readGitBlobRaw({ kind: 'index', worktreePath: '/repo', gitPath: 'b.txt' }, { signal })
    expect(mockedExec).toHaveBeenCalledWith(
      ['show', ':b.txt'],
      expect.objectContaining({ cwd: '/repo', signal })
    )
  })

  it('maps maxBuffer overflow to tooLarge', async () => {
    // Node's execFile overflow error: message mentions maxBuffer, which is what
    // isMaxBufferOverflowError matches (alongside code ENOBUFS).
    const error = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    })
    mockedExec.mockRejectedValue(error)
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'big.bin'
    })
    expect(raw).toEqual({ found: true, tooLarge: true })
  })

  it('maps an ENOBUFS overflow to tooLarge', async () => {
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOBUFS' })
    mockedExec.mockRejectedValue(error)
    const raw = await readGitBlobRaw({ kind: 'index', worktreePath: '/repo', gitPath: 'big.bin' })
    expect(raw).toEqual({ found: true, tooLarge: true })
  })

  it('maps any other error to not found', async () => {
    mockedExec.mockRejectedValue(new Error('fatal: bad object'))
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'deadbeef',
      gitPath: 'a.txt'
    })
    expect(raw).toEqual({ found: false, tooLarge: false })
  })
})

function fakeNativeModule(overrides: Partial<Record<'rev' | 'index', unknown>> = {}) {
  return {
    nativeGitPing: () => 1,
    readBlobAtRevPath: vi.fn(
      async () => overrides.rev ?? { found: true, tooLarge: false, data: Buffer.from('native') }
    ),
    readBlobAtIndexPath: vi.fn(
      async () => overrides.index ?? { found: true, tooLarge: false, data: Buffer.from('native') }
    )
  }
}

describe('readGitBlobRaw (native modes)', () => {
  it('serves native bytes in on mode without spawning git (after warmup sampling)', async () => {
    const native = fakeNativeModule()
    mockedLoad.mockReturnValue(native as never)
    mockedExec.mockResolvedValue({ stdout: Buffer.from('native') } as never)
    configureNativeGitBlobReads(() => 'on')
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'a.txt'
    })
    expect(raw.bytes?.toString()).toBe('native')
    expect(native.readBlobAtRevPath).toHaveBeenCalledWith(
      '/repo',
      'HEAD',
      'a.txt',
      MAX_GIT_SHOW_BYTES
    )
  })

  it('falls back to CLI when the native read throws', async () => {
    const native = fakeNativeModule()
    native.readBlobAtRevPath = vi.fn(async () => {
      throw new Error('native boom')
    })
    mockedLoad.mockReturnValue(native as never)
    mockedExec.mockResolvedValue({ stdout: Buffer.from('cli') } as never)
    configureNativeGitBlobReads(() => 'on')
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'a.txt'
    })
    expect(raw.bytes?.toString()).toBe('cli')
  })

  it('shadow mode serves the CLI result and reports byte divergence', async () => {
    mockedLoad.mockReturnValue(fakeNativeModule() as never)
    mockedExec.mockResolvedValue({ stdout: Buffer.from('cli-different') } as never)
    configureNativeGitBlobReads(() => 'shadow')
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'a.txt'
    })
    expect(raw.bytes?.toString()).toBe('cli-different')
    // Divergence is confirmed by a background re-verify before poisoning/telemetry.
    await vi.waitFor(() =>
      expect(track).toHaveBeenCalledWith('git_native_shadow_divergence', {
        read_kind: 'rev',
        divergence: 'bytes'
      })
    )
  })

  it('shadow mode reports presence divergence when native and CLI disagree on existence', async () => {
    mockedLoad.mockReturnValue(
      fakeNativeModule({ rev: { found: false, tooLarge: false } }) as never
    )
    mockedExec.mockResolvedValue({ stdout: Buffer.from('cli') } as never)
    configureNativeGitBlobReads(() => 'shadow')
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'a.txt'
    })
    expect(raw.bytes?.toString()).toBe('cli')
    await vi.waitFor(() =>
      expect(track).toHaveBeenCalledWith('git_native_shadow_divergence', {
        read_kind: 'rev',
        divergence: 'presence'
      })
    )
  })

  it('poisons the session after a sampled divergence in on mode', async () => {
    const native = fakeNativeModule()
    mockedLoad.mockReturnValue(native as never)
    mockedExec.mockResolvedValue({ stdout: Buffer.from('cli-truth') } as never)
    configureNativeGitBlobReads(() => 'on')
    await readGitBlobRaw({ kind: 'rev', worktreePath: '/repo', rev: 'HEAD', gitPath: 'a.txt' })
    await vi.waitFor(() =>
      expect(track).toHaveBeenCalledWith('git_native_shadow_divergence', expect.anything())
    )
    native.readBlobAtRevPath = vi.fn()
    const raw = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'b.txt'
    })
    expect(native.readBlobAtRevPath).not.toHaveBeenCalled()
    expect(raw.bytes?.toString()).toBe('cli-truth')
  })

  it('does not poison when a divergence does not reproduce on re-verify (transient state change)', async () => {
    // Native returns stale bytes on the first read but agrees with the CLI on
    // the re-verify — a legitimate concurrent stage/commit, not a gix bug. The
    // session must NOT poison and no divergence event may fire.
    const native = fakeNativeModule()
    native.readBlobAtRevPath = vi
      .fn()
      .mockResolvedValueOnce({ found: true, tooLarge: false, data: Buffer.from('stale') })
      .mockResolvedValue({ found: true, tooLarge: false, data: Buffer.from('fresh') })
    mockedLoad.mockReturnValue(native as never)
    mockedExec.mockResolvedValue({ stdout: Buffer.from('fresh') } as never)
    configureNativeGitBlobReads(() => 'on')
    const first = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'a.txt'
    })
    expect(first.bytes?.toString()).toBe('stale')
    // Initial native read + the re-verify's native re-read = 2 calls.
    await vi.waitFor(() => expect(native.readBlobAtRevPath).toHaveBeenCalledTimes(2))
    expect(track).not.toHaveBeenCalled()
    // Not poisoned: the next read still serves native (now the fresh value).
    const second = await readGitBlobRaw({
      kind: 'rev',
      worktreePath: '/repo',
      rev: 'HEAD',
      gitPath: 'b.txt'
    })
    expect(second.bytes?.toString()).toBe('fresh')
  })

  it('never uses native for WSL-routed reads', async () => {
    const native = fakeNativeModule()
    mockedLoad.mockReturnValue(native as never)
    mockedExec.mockResolvedValue({ stdout: Buffer.from('cli') } as never)
    configureNativeGitBlobReads(() => 'on')
    await readGitBlobRaw(
      { kind: 'rev', worktreePath: '/repo', rev: 'HEAD', gitPath: 'a.txt' },
      { wslDistro: 'Ubuntu' }
    )
    expect(native.readBlobAtRevPath).not.toHaveBeenCalled()
  })

  it('maps a post-read aborted signal to not-found, matching the CLI catch path', async () => {
    mockedLoad.mockReturnValue(fakeNativeModule() as never)
    configureNativeGitBlobReads(() => 'on')
    const controller = new AbortController()
    controller.abort()
    const raw = await readGitBlobRaw(
      { kind: 'rev', worktreePath: '/repo', rev: 'HEAD', gitPath: 'a.txt' },
      { signal: controller.signal }
    )
    expect(raw).toEqual({ found: false, tooLarge: false })
  })

  it('off mode never touches the native module', async () => {
    const native = fakeNativeModule()
    mockedLoad.mockReturnValue(native as never)
    mockedExec.mockResolvedValue({ stdout: Buffer.from('cli') } as never)
    configureNativeGitBlobReads(() => 'off')
    await readGitBlobRaw({ kind: 'rev', worktreePath: '/repo', rev: 'HEAD', gitPath: 'a.txt' })
    expect(native.readBlobAtRevPath).not.toHaveBeenCalled()
  })

  it('does not fire a background verify for an unsampled read (1/128 cadence)', async () => {
    const native = fakeNativeModule()
    mockedLoad.mockReturnValue(native as never)
    // Native and CLI agree so the warmup verifies never poison the session.
    mockedExec.mockResolvedValue({ stdout: Buffer.from('native') } as never)
    configureNativeGitBlobReads(() => 'on')
    // Warmup: the first three reads are always sampled -> three verify spawns.
    for (let i = 0; i < 3; i++) {
      await readGitBlobRaw({ kind: 'rev', worktreePath: '/repo', rev: 'HEAD', gitPath: 'a.txt' })
    }
    expect(mockedExec).toHaveBeenCalledTimes(3)
    mockedExec.mockClear()
    // Read #4 is not a 1/128 multiple, so no verify CLI read must spawn.
    await readGitBlobRaw({ kind: 'rev', worktreePath: '/repo', rev: 'HEAD', gitPath: 'a.txt' })
    expect(mockedExec).not.toHaveBeenCalled()
  })
})

describe('resolveNativeGitMode (kill switch)', () => {
  const original = process.env.ORCA_NATIVE_GIT
  afterEach(() => {
    if (original === undefined) {
      delete process.env.ORCA_NATIVE_GIT
    } else {
      process.env.ORCA_NATIVE_GIT = original
    }
  })

  it('forces off when ORCA_NATIVE_GIT=0, even with the setting on', () => {
    process.env.ORCA_NATIVE_GIT = '0'
    expect(resolveNativeGitMode(true)).toBe('off')
  })

  it('accepts off/false as disable synonyms (case- and space-insensitive)', () => {
    process.env.ORCA_NATIVE_GIT = '  OFF '
    expect(resolveNativeGitMode(true)).toBe('off')
    process.env.ORCA_NATIVE_GIT = 'false'
    expect(resolveNativeGitMode(true)).toBe('off')
  })

  it('selects shadow when ORCA_NATIVE_GIT=shadow', () => {
    process.env.ORCA_NATIVE_GIT = 'shadow'
    expect(resolveNativeGitMode(false)).toBe('shadow')
  })

  it('forces on when ORCA_NATIVE_GIT=1, even with the setting off', () => {
    process.env.ORCA_NATIVE_GIT = '1'
    expect(resolveNativeGitMode(false)).toBe('on')
  })

  it('falls back to the experimental setting when the env var is unset', () => {
    delete process.env.ORCA_NATIVE_GIT
    expect(resolveNativeGitMode(true)).toBe('on')
    expect(resolveNativeGitMode(false)).toBe('off')
    expect(resolveNativeGitMode(undefined)).toBe('off')
  })
})
