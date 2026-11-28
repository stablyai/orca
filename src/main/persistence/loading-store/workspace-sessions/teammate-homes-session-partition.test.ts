import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', async (original) => ({
  ...(await original<object>()),
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

import { randomUUID } from 'node:crypto'
import {
  closeTestStores,
  createStore,
  readDataFile,
  testState
} from '../../persistence-test-harness'
import { dropInvalidWorkspaceLayoutsAtLoad } from '../../restoring-sessions/invalid-workspace-layout-purge'
import { RuntimeWorkspaceSessionController } from '../../../runtime/workspaces/session-hosts/runtime-workspace-session-controller'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { registerSessionHandlers } from '../../../ipc/session'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { sessionPartitions } from '../../migrating-orcad-catalog/source/sessions/orcad-source-workspace-session-fragments'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { personWorkspaceKey } from '../../../../shared/workspace/identity/person-workspace-key'
import { TEAMMATE_HOMES_SESSION_PARTITION as TEAM } from '../../../../shared/workspace-session/teammate-homes-session-partition'

const K = personWorkspaceKey({ folderWorkspaceId: 'home-1', botId: 'bot-1', accountId: 'usr_mate' })

/** A store whose teammate opened one browser tab in their own list. */
async function storeWithTeammateTab() {
  const store = createStore()
  const applied = await store.applyLayoutCommand({ type: 'openBrowserTab', workspace: K }, [TEAM])
  expect(applied).toMatchObject({ ok: true })
  return store
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-teammate-homes-'))
})

afterEach(async () => {
  await closeTestStores()
  handlers.clear()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe("the teammates' session partition", () => {
  it('survives a restart, and its writes never reach the local partition', async () => {
    const local = structuredClone(createStore().getWorkspaceSession('local'))
    const store = await storeWithTeammateTab()
    store.flush()

    const reloaded = createStore()
    const team = reloaded.getWorkspaceSession(TEAM)
    expect(team.tabGroups?.[K]).toHaveLength(1)
    expect(team.unifiedTabs?.[K]).toHaveLength(1)
    expect(reloaded.getWorkspaceSession('local')).toEqual(local)
    // No host enumeration names it: it is no machine.
    expect(reloaded.getWorkspaceSessionHostIds()).toEqual(['local'])
  })

  it('is never listed, read or written by the window', async () => {
    const store = await storeWithTeammateTab()
    const team = structuredClone(store.getWorkspaceSession(TEAM))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only an unfenced main-owned save reads the runtime; every write here is fenced.
    registerSessionHandlers(store, {} as OrcaRuntimeService)
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

    expect(await invoke('session:list-host-ids')).toEqual(['local'])
    expect(await invoke('session:get', TEAM)).toEqual(getDefaultWorkspaceSession())
    expect(await invoke('session:set', getDefaultWorkspaceSession(), TEAM)).toEqual({
      status: 'skipped'
    })
    await invoke('session:patch', { tabGroups: {} }, TEAM)
    expect(await invoke('session:patch-entries', { tabGroups: {} }, TEAM)).toEqual({
      status: 'skipped'
    })
    expect(store.getWorkspaceSession(TEAM)).toEqual(team)
  })

  it("stays behind when the profile's sessions migrate to orcad", async () => {
    const store = await storeWithTeammateTab()
    const state = {
      workspaceSession: store.getWorkspaceSession('local'),
      workspaceSessionsByHostId: { [TEAM]: store.getWorkspaceSession(TEAM) }
    }
    expect(sessionPartitions(state, 'local').map(([hostId]) => hostId)).toEqual(['local'])
  })

  it('keeps its workspaces through the load purge: no repo catalog proves one gone', async () => {
    const store = await storeWithTeammateTab()
    store.flush()
    dropInvalidWorkspaceLayoutsAtLoad(store, readDataFile())
    expect(store.getWorkspaceSession(TEAM).unifiedTabs?.[K]).toHaveLength(1)
  })

  it('removes a teammate’s workspace from its partition alone', async () => {
    const store = await storeWithTeammateTab()
    const local = structuredClone(store.getWorkspaceSession('local'))
    // A person's workspace runs on this machine; removal finds its partition from the key.
    store.removeWorkspaceSessionStateForWorktree(hostWorktreeTarget({ id: K, hostId: 'local' }))
    expect(store.getWorkspaceSession(TEAM).unifiedTabs?.[K] ?? []).toEqual([])
    expect(store.getWorkspaceSession('local')).toEqual(local)
  })

  it('moves a pane in a teammate’s terminal to a new tab, and hydrates their terminals', async () => {
    const store = createStore()
    const [tabId, leafId, newLeafId] = [randomUUID(), randomUUID(), randomUUID()]
    const commands = [
      { type: 'createTerminalTab', workspace: K, tabId, leafId },
      { type: 'splitPane', workspace: K, tabId, leafId, direction: 'vertical', newLeafId }
    ] as const
    for (const command of commands) {
      expect(await store.applyLayoutCommand(command, [TEAM])).toMatchObject({ ok: true })
    }
    const controller = new RuntimeWorkspaceSessionController({
      getStore: () => store,
      resolveFolderConnectionId: () => null,
      hasRuntimeOwnedPtyCandidate: () => true
    })
    expect(controller.getHydrationTargets(true).get(K)).toEqual(store.getWorkspaceSession(TEAM))

    const moved = await store.moveTerminalLeafToNewTab({
      worktreeId: K,
      sourceTabId: tabId,
      targetTabId: randomUUID(),
      leafId: newLeafId,
      ptyId: null
    })
    expect(moved).toMatchObject({ status: 'moved' })
  })
})
