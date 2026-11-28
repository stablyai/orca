// A teammate's own list in a shared agent's Home is a host workspace of its own, saved in the
// teammates' partition. Through the real runtime, store and record store.
import { afterEach, expect, it } from 'vitest'
import { resolveTabListTarget } from '../../runtime/session-tabs/person/person-workspace-target'
import { personWorkspaceKey } from '../../../shared/workspace/identity/person-workspace-key'
import { TEAMMATE_HOMES_SESSION_PARTITION as TEAM } from '../../../shared/workspace-session/teammate-homes-session-partition'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import { OTHER, rig, SCOPE, settleTeammateRig, TEAMMATE } from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

it("routes only a teammate's own Home calls to their list, and the owner's never reach its partition", async () => {
  const r = await rig({ home: 'other' })
  const bots = r.profile.getBots()
  const K = personWorkspaceKey({ folderWorkspaceId: r.home.slice('folder:'.length), ...TEAMMATE })

  expect(resolveTabListTarget(bots, r.home, SCOPE)).toEqual({ home: r.home, list: K })
  for (const scope of [undefined, { kind: 'owner' as const }, { ...SCOPE, botId: 'bot-2' }]) {
    expect(resolveTabListTarget(bots, r.home, scope)).toEqual({ home: r.home, list: r.home })
  }
  // A worker's workspace keeps one shared list.
  expect(resolveTabListTarget(bots, r.workspace, SCOPE)).toEqual({
    home: r.workspace,
    list: r.workspace
  })
  expect(resolveTabListTarget(bots, r.home, { ...SCOPE, ...OTHER }).list).not.toBe(K)

  await r.create('owner-desk', `id:${r.home}`)
  await r.list('owner-desk', `id:${r.home}`)
  expect(r.profile.getWorkspaceSessionHostIds()).toEqual(['local'])
  expect(r.profile.hasWorkspaceSessionHost(TEAM)).toBe(false)
})

it("keeps a write to a teammate's list off the owner's window, desktop, phones and saved layout", async () => {
  const r = await rig({ home: 'other' })
  const K = personWorkspaceKey({ folderWorkspaceId: r.home.slice('folder:'.length), ...TEAMMATE })
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home)
  try {
    const before = await probe.ownerState()
    const applied = await r.runtime.applyLayoutCommand({
      type: 'openBrowserTab',
      workspace: K,
      browserTabId: 'browser-1'
    })

    expect(applied).toMatchObject({ ok: true })
    expect(r.profile.getWorkspaceSession(TEAM).unifiedTabs?.[K]).toHaveLength(1)
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})
