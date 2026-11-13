import {
  worktreeRemovalLifetime,
  _resetWorktreeRemovalLifetimeForTests
} from '../workspaces/removal/worktree-removal-lifetime'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdRemovalMetadata } from '../workspaces/removal/worktree-removal-lifetime.test-fixtures'
import { readWorktreeRemovalRecords } from '../workspaces/removal/worktree-removal-records'
import { _resetPendingWorktreeRemovalsForTests } from '../workspaces/removal/worktree-background-removal'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServeDesktopActivationGate } from './serve-launch/serve-desktop-activation'

const { state, foundation, runtime, i18n, launch } = vi.hoisted(() => ({
  state: {
    profileShutdownCheckpoint: null as Promise<void> | null,
    store: {
      flushPendingOrThrowAsync: vi.fn(async () => {}),
      freezeWritesAsync: vi.fn(async () => {})
    },
    profileStateAdmission: initialAdmission(),
    desktopActivationGate: initialActivationGate(),
    mainProcessI18nReady: Promise.resolve()
  },
  foundation: vi.fn(async () => {}),
  runtime: vi.fn(async () => {}),
  i18n: vi.fn(async () => {}),
  launch: vi.fn(async () => {})
}))

function initialAdmission(): { release(): void } | undefined {
  return undefined
}

function initialActivationGate(): ServeDesktopActivationGate | null {
  return null
}

vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('./main-process-ready-foundation', () => ({ initializeReadyFoundation: foundation }))
vi.mock('./main-process-ready-runtime', () => ({ initializeReadyRuntimeServices: runtime }))
vi.mock('./main-window/main-process-i18n-menu', () => ({ initializeMainProcessI18nAndMenu: i18n }))
vi.mock('./runtime-startup/main-process-runtime-launch', () => ({
  initializeMainProcessRuntimeLaunch: launch
}))

import { initializeMainProcessReady } from './main-process-ready'

const options = {
  openMainWindow: (): never => {
    throw new Error('Unexpected window creation in startup cleanup test')
  },
  handleMacAppActivation: () => {}
}

beforeEach(() => {
  _resetWorktreeRemovalLifetimeForTests()
  vi.clearAllMocks()
  state.profileStateAdmission = { release: vi.fn() }
  state.desktopActivationGate = null
  state.profileShutdownCheckpoint = null
})

describe('startup persistence lifetime', () => {
  it('awaits writer release after a later startup phase fails', async () => {
    const failure = new Error('runtime startup failed')
    const admission = state.profileStateAdmission
    runtime.mockRejectedValueOnce(failure)
    let release = () => {}
    state.store.freezeWritesAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const ready = initializeMainProcessReady(options)
    const rejected = expect(ready).rejects.toBe(failure)
    await vi.waitFor(() => expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce())
    expect(admission?.release).not.toHaveBeenCalled()
    release()
    await rejected
    expect(admission?.release).toHaveBeenCalledOnce()
    expect(state.profileStateAdmission).toBeUndefined()
    expect(launch).not.toHaveBeenCalled()
  })

  it('keeps the original startup failure when cleanup also fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('foundation failed')
    foundation.mockRejectedValueOnce(failure)
    state.store.freezeWritesAsync.mockRejectedValueOnce(new Error('close failed'))
    try {
      await expect(initializeMainProcessReady(options)).rejects.toBe(failure)
      expect(log).toHaveBeenCalledOnce()
      expect(state.profileStateAdmission?.release).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})

it('freezes the profile after a drained removal fails without releasing its ownership', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      worktreeRemovalLifetime.prepare(
        async () => {
          throw new Error('load failed')
        },
        () => {},
        async () => {}
      )
    ).rejects.toThrow('load failed')
    const failure = new Error('runtime startup failed')
    runtime.mockRejectedValueOnce(failure)
    await expect(initializeMainProcessReady(options)).rejects.toBe(failure)
    expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
    expect(state.profileStateAdmission?.release).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})

it('joins successful removal metadata and its journal before failed startup freezes or releases the profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-startup-removal-'))
  try {
    const pending = await holdRemovalMetadata(directory)
    const failure = new Error('runtime startup failed')
    runtime.mockRejectedValueOnce(failure)
    const rejected = expect(initializeMainProcessReady(options)).rejects.toBe(failure)
    await vi.waitFor(() => expect(worktreeRemovalLifetime.closing).toBe(true))
    expect(state.store.freezeWritesAsync).not.toHaveBeenCalled()
    expect(state.profileStateAdmission?.release).not.toHaveBeenCalled()
    expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)
    pending.release()
    await rejected
    await pending.result
    expect(await readFile(join(directory, 'metadata-finished'), 'utf8')).toBe('removed')
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
    expect(state.profileStateAdmission).toBeUndefined()
  } finally {
    vi.restoreAllMocks()
    _resetPendingWorktreeRemovalsForTests()
    await rm(directory, { recursive: true, force: true })
  }
})
