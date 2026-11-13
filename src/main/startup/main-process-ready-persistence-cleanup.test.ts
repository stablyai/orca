import { Store } from '../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServeDesktopActivationGate } from './serve-launch/serve-desktop-activation'

const { state, foundation, runtime, i18n, launch } = vi.hoisted(() => ({
  state: {
    profileShutdownCheckpoint: null as Promise<void> | null,
    store: {
      flushPendingOrThrowAsync: vi.fn(async () => {}),
      flushFinalOrThrowAsync: vi.fn(async () => {}),
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

const stubStore = state.store

afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  vi.useRealTimers()
  _resetPendingWorktreeRemovalsForTests()
})

beforeEach(() => {
  state.store = stubStore
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
    expect(state.store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
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

it('persists successful removal metadata after the early startup checkpoint before releasing its profile', async () => {
  vi.useFakeTimers()
  const directory = await mkdtemp(join(tmpdir(), 'orca-startup-final-save-'))
  const dataFile = join(directory, 'orca-data.json')
  const profile = createSqliteTestStore(Store, { dataFile })
  const target = hostWorktreeTarget({ id: 'repo::feature', hostId: 'local' })
  profile.setWorktreeMeta(target, { displayName: 'Pending workspace' })
  await profile.flushPendingOrThrowAsync({ fullCheckpoint: true })
  const checkpoint = Promise.withResolvers<void>()
  state.store = {
    flushPendingOrThrowAsync: vi.fn(async () => {
      await profile.flushPendingOrThrowAsync({ fullCheckpoint: true })
      checkpoint.resolve()
    }),
    flushFinalOrThrowAsync: vi.fn(() => profile.flushFinalOrThrowAsync()),
    freezeWritesAsync: vi.fn(() => profile.freezeWritesAsync())
  }
  const admission = state.profileStateAdmission
  const pending = await holdRemovalMetadata(directory, () => profile.removeWorktreeMeta(target))
  const failure = new Error('runtime startup failed')
  runtime.mockRejectedValueOnce(failure)
  const rejected = expect(initializeMainProcessReady(options)).rejects.toBe(failure)
  try {
    await checkpoint.promise
    expect(
      JSON.parse(readPersistedStateJson(dataFile)).worktreeMeta['repo::feature']
    ).toMatchObject({ displayName: 'Pending workspace' })
    expect(state.store.flushFinalOrThrowAsync).not.toHaveBeenCalled()
    expect(admission?.release).not.toHaveBeenCalled()
    pending.release()
    await rejected
    await pending.result
    expect(
      JSON.parse(readPersistedStateJson(dataFile)).worktreeMeta['repo::feature']
    ).toBeUndefined()
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    expect(admission?.release).toHaveBeenCalledOnce()
  } finally {
    pending.release()
    await closeTestStores()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['final-save', 'early-checkpoint'] as const)(
  'still freezes after a %s failure and preserves the startup error',
  async (phase) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('runtime startup failed')
    runtime.mockRejectedValueOnce(failure)
    if (phase === 'final-save') {
      state.store.flushFinalOrThrowAsync.mockRejectedValueOnce(new Error('save failed'))
    } else {
      state.store.flushPendingOrThrowAsync.mockRejectedValueOnce(new Error('early save failed'))
    }
    const admission = state.profileStateAdmission
    await expect(initializeMainProcessReady(options)).rejects.toBe(failure)
    expect(state.store.flushFinalOrThrowAsync).toHaveBeenCalledOnce()
    expect(state.store.freezeWritesAsync).toHaveBeenCalledOnce()
    if (phase === 'final-save') {
      expect(admission?.release).not.toHaveBeenCalled()
    } else {
      expect(admission?.release).toHaveBeenCalledOnce()
    }
    log.mockRestore()
  }
)
