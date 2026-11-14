import { Store } from '../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { _resetWorktreeRemovalLifetimeForTests } from '../workspaces/removal/worktree-removal-lifetime'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdRemovalMetadata } from '../workspaces/removal/worktree-removal-lifetime.test-fixtures'
import { readWorktreeRemovalRecords } from '../workspaces/removal/worktree-removal-records'
import { _resetPendingWorktreeRemovalsForTests } from '../workspaces/removal/worktree-background-removal'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
