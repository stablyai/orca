import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import { TEST_LEAF_1 } from '../../../persistence/persistence-session-fixtures'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import { installClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation,
  resolvePaneSpawnReservation
} from '../pane/spawn-reservation'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type * as SpawnReplacementModule from './spawn-replacement'
import type * as PaneOwnerReplacementModule from '../pane/pane-owner-replacement'
import type { AdoptStablePaneArgs } from '../ipc/spawn-types'
import type { RuntimePtySpawnArgs } from './spawn-state'
import { spawnPtyFromRuntimeController } from './spawn'

// The orchestration under test is spawn.ts; every stage after the replacement is a fake.
const stages = vi.hoisted(() => ({
  begin: vi.fn(),
  release: vi.fn(async () => {}),
  execute: vi.fn(async () => {}),
  commit: vi.fn(async () => ({ kind: 'committed' as const, result: { id: 'new' } }))
}))
vi.mock('./spawn-replacement', async (importOriginal) => ({
  ...(await importOriginal<typeof SpawnReplacementModule>()),
  beginRuntimePaneReplacement: stages.begin
}))
vi.mock('../pane/pane-owner-replacement', async (importOriginal) => ({
  ...(await importOriginal<typeof PaneOwnerReplacementModule>()),
  releaseStoppedPaneBinding: stages.release
}))
vi.mock('../spawn-begin', () => ({ beginPtySpawn: async () => null }))
vi.mock('../spawn-resume', () => ({ prepareSavedPtyResume: async () => async () => {} }))
vi.mock('./spawn-preflight', () => ({ prepareRuntimePtySpawn: async () => null }))
vi.mock('./spawn-options', () => ({ buildRuntimePtySpawnOptions: async () => null }))
vi.mock('../spawn-execute', () => ({ executePtySpawn: stages.execute }))
vi.mock('./spawn-commit', () => ({ commitRuntimePtySpawn: stages.commit }))

const worktreeId = 'repo-local::/fixture/local'
const tabId = 'restart-tab'
const paneKey = makePaneKey(tabId, TEST_LEAF_1)
const reservationKey = makePaneSpawnReservationKey(worktreeId, null, paneKey)!
const replaced: ReplacedPaneOwner = {
  ptyId: 'old',
  pane: { worktreeId, tabId, leafId: TEST_LEAF_1, hostId: undefined }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every store reader is faked out; only its identity is asserted.
const store = {} as unknown as Store
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the faked stages read nothing from deps; spawn.ts reads only store and runtime.
const deps = {
  store,
  runtime: undefined,
  adoptStablePane: async (args: AdoptStablePaneArgs) => {
    const result = await args.spawnFresh!({ mustExist: false })
    resolvePaneSpawnReservation(reservationKey, args.reservation, result)
    return null
  }
} as unknown as PtyRuntimeControllerDeps
const prepareLaunchFor = vi.fn(async () => ({
  configDir: '/b',
  envPatch: { CLAUDE_CONFIG_DIR: '/b' },
  provenance: 'profile:b' as const
}))

function replacing(overrides: Partial<RuntimePtySpawnArgs> = {}): RuntimePtySpawnArgs {
  return {
    cols: 80,
    rows: 24,
    worktreeId,
    connectionId: null,
    tabId,
    leafId: TEST_LEAF_1,
    command: 'claude --resume s1',
    replacesPtyId: 'old',
    persistHostSessionBinding: true,
    ...overrides
  }
}

beforeEach(() => {
  stages.begin.mockImplementation(async (_deps, args) => ({
    reservationKey,
    reservation: args.reservation,
    replaced
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only prepareLaunchFor is read.
  installClaudeProfileRouter({ prepareLaunchFor } as unknown as ClaudeProfileRouter)
})

afterEach(() => {
  vi.clearAllMocks()
  installClaudeProfileRouter(undefined)
  for (const [key, reservation] of paneSpawnReservationsByOwnerKey) {
    rejectPaneSpawnReservation(key, reservation, new Error('test teardown'))
  }
})

describe('a runtime pane replacement refuses bad input before the stop', () => {
  it('needs a persisted binding: no stop, no account preparation', async () => {
    await expect(
      spawnPtyFromRuntimeController(
        deps,
        replacing({ persistHostSessionBinding: undefined, claudeAccountId: 'b' })
      )
    ).rejects.toThrow('replacesPtyId requires persistHostSessionBinding')
    expect(stages.begin).not.toHaveBeenCalled()
    expect(prepareLaunchFor).not.toHaveBeenCalled()
  })

  it("refuses an invalid pane with preflight's own message and stops nothing", async () => {
    await expect(
      spawnPtyFromRuntimeController(deps, replacing({ leafId: 'not-a-leaf' }))
    ).rejects.toThrow('Cannot persist runtime PTY binding without worktreeId, tabId, and leafId')
    expect(stages.begin).not.toHaveBeenCalled()
  })

  it('prepares the named account before the stop for a Claude launch only', async () => {
    await spawnPtyFromRuntimeController(deps, replacing({ command: 'bash', claudeAccountId: 'b' }))
    expect(prepareLaunchFor).not.toHaveBeenCalled()
    expect(stages.begin).toHaveBeenCalledTimes(1)

    await spawnPtyFromRuntimeController(deps, replacing({ claudeAccountId: 'b' }))
    expect(prepareLaunchFor).toHaveBeenCalledWith('b')
    expect(prepareLaunchFor.mock.invocationCallOrder[0]).toBeLessThan(
      stages.begin.mock.invocationCallOrder[1]
    )
    expect(stages.begin).toHaveBeenLastCalledWith(deps, {
      replacesPtyId: 'old',
      paneKey,
      worktreeId,
      connectionId: null,
      reservation: expect.any(Object)
    })
  })
})

describe('a runtime pane replacement that fails after the stop', () => {
  it('releases the stopped binding and settles the held reservation', async () => {
    stages.execute.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(spawnPtyFromRuntimeController(deps, replacing())).rejects.toThrow('spawn failed')
    expect(stages.release).toHaveBeenCalledWith(store, replaced)
    expect(paneSpawnReservationsByOwnerKey.has(reservationKey)).toBe(false)
    expect(stages.commit).not.toHaveBeenCalled()
  })
})
