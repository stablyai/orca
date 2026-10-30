import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNotFoundError } from '../../daemon/daemon-errors'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  installRestartHarness,
  leafId,
  paneKey,
  registerWithFakes,
  restartSpawnArgs,
  tabId
} from './pty-pane-owner-swap.test-fixture'
import { WorkspaceLayoutStream } from '../../runtime/workspace-layout-stream'
import { keepAbsentBindingForSwap } from './ipc/spawn-absent-binding-swap'
import type { WorkspaceLayoutStreamEvent } from '../../../shared/workspace-layout/workspace-layout-stream-frames'

const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

type Harness = ReturnType<typeof installRestartHarness>
type StreamStore = ReturnType<ConstructorParameters<typeof WorkspaceLayoutStream>[0]['store']>

/** Main's layout stream over the harness Store, as a window subscribes to it. */
function watchLayout(store: Harness['store']): {
  events: WorkspaceLayoutStreamEvent[]
  shownPtyId: string | undefined
} {
  const stream = new WorkspaceLayoutStream({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream reads only the session getters and the write listener this fake defines.
    store: () => store as unknown as StreamStore,
    homeHostId: () => 'local',
    liveTitle: () => null
  })
  const events: WorkspaceLayoutStreamEvent[] = []
  const { snapshot } = stream.subscribe((event) => events.push(event))
  const pane = snapshot
    .flatMap(({ layout }) => layout.tabs)
    .find((tab) => tab.entityId === tabId)
    ?.terminal?.panes.find((candidate) => candidate.leafId === leafId)
  return { events, shownPtyId: pane?.ptyId }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const recordsOf = (events: WorkspaceLayoutStreamEvent[]) =>
  events.map((event) =>
    event.type === 'records'
      ? event.workspaces.map(({ key: _key, ...change }) => change)
      : `${event.type} frame`
  )

describe('pty:spawn for a restored pane whose process is gone', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  async function respawn(
    options: Parameters<typeof installRestartHarness>[0],
    prepare: (harness: Harness) => void = () => {}
  ) {
    const harness = installRestartHarness({ oldSessionAbsent: true, ...options })
    prepare(harness)
    const retire = vi.spyOn(harness.store, 'retirePtyBinding')
    registerWithFakes(mainWindow, harness.runtime, harness.store)
    const layout = watchLayout(harness.store)
    const spawned = handlers.get('pty:spawn')!(null, restartSpawnArgs())
    return { ...harness, retire, layout, spawned }
  }

  describe('in a layout-owner build', () => {
    beforeEach(() => {
      layoutOwner.isMain = true
    })
    afterEach(() => {
      layoutOwner.isMain = false
    })

    it('rebinds the same id in one write and publishes its one binding record', async () => {
      const { spawned, durableBindings, boundAtFreshLaunch, retire, layout } = await respawn({
        freshId: 'pty-old'
      })

      await expect(spawned).resolves.toMatchObject({ id: 'pty-old' })
      await settle()
      expect(layout.shownPtyId).toBe('pty-old')
      expect(boundAtFreshLaunch).toEqual(['pty-old'])
      expect(durableBindings).toEqual(['pty-old'])
      expect(retire).not.toHaveBeenCalled()
      // A higher generation distinguishes the replacement from its dead predecessor.
      expect(recordsOf(layout.events)).toEqual([
        [{ change: 'records', bindings: { set: [{ leafId, ptyId: 'pty-old', ptyGeneration: 1 }] } }]
      ])
    })

    it('swaps a new id in one write and publishes one frame', async () => {
      const { spawned, durableBindings, store, layout } = await respawn({})

      await expect(spawned).resolves.toMatchObject({ id: 'pty-new' })
      await settle()
      expect(layout.shownPtyId).toBe('pty-old')
      expect(durableBindings).toEqual(['pty-new'])
      expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey).toEqual({
        [paneKey]: 'inc-new'
      })
      expect(recordsOf(layout.events)).toEqual([
        [{ change: 'records', bindings: { set: [{ leafId, ptyId: 'pty-new', ptyGeneration: 1 }] } }]
      ])
    })

    it('drops the dead incarnation when the fresh process reports none, as the retire did', async () => {
      const { spawned, durableBindings, store } = await respawn({
        freshId: 'pty-old',
        freshIncarnationId: null
      })

      await expect(spawned).resolves.toMatchObject({ id: 'pty-old' })
      expect(durableBindings).toEqual(['pty-old'])
      expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey).toEqual({})
    })

    it('keeps the swapped same-id binding when a later commit step fails', async () => {
      const { spawned, leafBinding, retire } = await respawn(
        { freshId: 'pty-old' },
        ({ runtime }) => {
          runtime.registerPty.mockImplementation(() => {
            throw new Error('register failed')
          })
        }
      )

      await expect(spawned).rejects.toThrow('register failed')
      expect(retire).not.toHaveBeenCalled()
      expect(leafBinding()).toBe('pty-old')
    })

    it('keeps the early retire for a pane on an SSH host', () => {
      const spawnOn = (connectionId?: string) =>
        keepAbsentBindingForSwap(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the swap gate reads only args, the reservation and the replaced owner.
          {
            args: { connectionId },
            paneSpawnReservation: {},
            replacedPaneOwner: null
          } as unknown as Parameters<typeof keepAbsentBindingForSwap>[0]
        )
      expect(spawnOn()).toBeTypeOf('function')
      // Its dead owner lives on that host, which the swap does not reach.
      expect(spawnOn('ssh-conn-1')).toBeUndefined()
    })

    it('still retires the dead binding when the fresh spawn fails', async () => {
      const { spawned, leafBinding } = await respawn({}, ({ providerSpawn }) => {
        providerSpawn.mockRejectedValueOnce(new SessionNotFoundError('pty-old'))
        providerSpawn.mockRejectedValueOnce(new Error('spawn failed'))
      })

      await expect(spawned).rejects.toThrow('spawn failed')
      expect(leafBinding()).toBeUndefined()
    })
  })

  it('keeps the early retire in a window-owned build', async () => {
    const { spawned, durableBindings, boundAtFreshLaunch, retire } = await respawn({
      freshId: 'pty-old'
    })

    await expect(spawned).resolves.toMatchObject({ id: 'pty-old' })
    expect(boundAtFreshLaunch).toEqual([undefined])
    expect(durableBindings).toEqual([undefined, 'pty-old'])
    expect(retire).toHaveBeenCalledTimes(1)
  })
})
