// A teammate's own terminals in a shared agent's Home: their workspace-wide acts take their own list,
// and nothing their terminals do (bells, finished agents, sizes) reaches the owner. Through the real
// dispatcher, runtime and record store; the host's PTY daemon is the only stand-in.
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentHookStatusRowMutation } from '../../agent-hooks/server/server-types'
import type { PtyLayoutTarget } from '../../runtime/terminal/layout/terminal-layout-state'
import type { AgentStatusStoreView } from '../../runtime/sidebar-inputs/workspace-facts/workspace-activity-facts-producer'
import {
  B,
  C,
  O,
  openTerminal,
  rig,
  settleTeammateRig,
  startTerminalsOnTheHost
} from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

type Rig = Awaited<ReturnType<typeof rig>>

const live = (r: Rig, ptyId: string) => r.runtime['ptysById'].get(ptyId)?.connected === true

const listed = async (r: Rig, deviceId: string) =>
  z
    .object({ terminals: z.array(z.looseObject({ ptyId: z.string().nullable() })) })
    .parse(await r.call(deviceId, 'terminal.list', { worktree: `id:${r.workspace}` }))
    .terminals.map((row) => row.ptyId)

/** The owner's and Mate's terminals in the Home, opened before the owner's window is watched. */
async function bothTerminals(r: Rig) {
  startTerminalsOnTheHost(r)
  const owners = await openTerminal(r, 'owner-desk')
  const mates = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  return { owners, mates }
}

it('stops or closes all of a Home’s terminals in the caller’s own list alone', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)
  const worktree = `id:${r.workspace}`
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home, { ownerPtyIds: [owners.ptyId] })
  try {
    const before = await probe.ownerState()
    // Sleeping all of them stays the owner's.
    for (const method of ['terminal.sleep', 'worktree.sleep']) {
      expect(await r.send('mate-desk', method, { worktree }), method).toMatchObject({ ok: false })
    }
    await r.call('mate-desk', 'terminal.stop', { worktree })
    await chatTabCommandsSettled()
    expect(live(r, mates.ptyId)).toBe(false)
    expect(live(r, owners.ptyId)).toBe(true)
    expect(await probe.ownerState()).toBe(before)

    const again = await openTerminal(r, 'mate-desk')
    await chatTabCommandsSettled()
    expect(await r.call('mate-desk', 'terminal.closeAll', { worktree })).toMatchObject({
      closed: 1,
      stopped: 1
    })
    await chatTabCommandsSettled()
    expect(live(r, again.ptyId)).toBe(false)
    expect(live(r, owners.ptyId)).toBe(true)
    expect((await r.list('mate-desk')).tabs).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }

  // The owner's closes the host's list alone, as before.
  const matesLast = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  await r.call('owner-desk', 'terminal.closeAll', { worktree })
  expect(live(r, owners.ptyId)).toBe(false)
  expect(live(r, matesLast.ptyId)).toBe(true)
})

it('lists a teammate’s own terminals alone in their Home, and every one of them to the owner', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)

  expect(await listed(r, 'mate-desk')).toEqual([mates.ptyId])
  expect(await listed(r, 'other-desk')).toEqual([])
  expect((await listed(r, 'owner-desk')).sort()).toEqual([owners.ptyId, mates.ptyId].sort())
})

it('keeps a finished agent in a teammate’s terminal off the owner’s sidebar and notification feeds', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)
  const hooks = hookStatusStore(r)
  // The owner's sort stamps and pushes follow the host lists' feed; orchestration follows every pane.
  const ownersFeed: string[] = []
  const everyPane: string[] = []
  const stops = [
    r.runtime.agentTransitions.subscribeHostLists((change) => ownersFeed.push(change.paneKey)),
    r.runtime.agentTransitions.subscribe((change) => everyPane.push(change.paneKey))
  ]
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home, { ownerPtyIds: [owners.ptyId] })
  // An agent in the terminal reports as a hook script does (its pane and workspace), works, then
  // finishes.
  const runAgent = (terminalTabId: string) => {
    const [tabId, leafId] = terminalTabId.split('::')
    const paneKey = makePaneKey(tabId!, leafId!)
    hooks.report({ paneKey, worktreeId: r.workspace, state: 'working' })
    hooks.report({ paneKey, worktreeId: r.workspace, state: 'done' })
    return paneKey
  }
  try {
    const before = await probe.ownerState()
    const matesPane = runAgent(mates.id)
    await chatTabCommandsSettled()
    expect(everyPane).toContain(matesPane)
    expect(ownersFeed).toEqual([])
    expect(probe.relays.filter((relay) => relay.via !== 'window')).toEqual([])
    expect(await probe.ownerState()).toBe(before)

    expect(ownersFeed).toEqual([])
    const ownersPane = runAgent(owners.id)
    expect(ownersFeed).toContain(ownersPane)
  } finally {
    probe.close()
    for (const stop of stops) {
      stop()
    }
    hooks.detach()
  }
})

/** The hook server's status rows, as the runtime's transitions read them. */
function hookStatusStore(r: Rig) {
  const rows = new Map<string, AgentStatusIpcPayload>()
  const listeners = new Set<(mutation: AgentHookStatusRowMutation) => void>()
  let receivedAt = Date.now()
  const store: AgentStatusStoreView = {
    getStatusSnapshot: () => [...rows.values()],
    getStatusSnapshotForPane: (paneKey) => (rows.has(paneKey) ? [rows.get(paneKey)!] : []),
    subscribeStatusRowMutations: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeStatusFreshness: () => () => {}
  }
  const detach = r.runtime.attachAgentStatusStore(store)
  return {
    report: (row: { paneKey: string; worktreeId: string; state: 'working' | 'done' }) => {
      const before = rows.get(row.paneKey) ?? null
      receivedAt += 1
      const after: AgentStatusIpcPayload = {
        ...row,
        agentType: 'claude',
        prompt: '',
        connectionId: null,
        stateStartedAt: receivedAt,
        receivedAt
      }
      rows.set(row.paneKey, after)
      for (const listener of listeners) {
        listener({ before, after })
      }
    },
    detach
  }
}

it('sleeps a teammate’s own chats alone in their Home, and every chat there for the owner', async () => {
  const r = await rig()
  const slept = async (deviceId: string) => {
    const result = z
      .object({
        stoppedSessionIds: z.array(z.string()),
        failures: z.array(z.looseObject({ sessionId: z.string().optional() })).optional()
      })
      .parse(
        await r.call(deviceId, 'agentSession.sleepWorkspace', {
          workspaceId: r.home
        })
      )
    return [
      ...result.stoppedSessionIds,
      ...(result.failures ?? []).flatMap((f) => f.sessionId ?? [])
    ]
  }

  const mates = await slept('mate-desk')
  expect(mates).not.toContain(O)
  expect(mates.length).toBeGreaterThan(0)
  expect(mates.every((sessionId) => [B, C].includes(sessionId))).toBe(true)
  expect(await slept('owner-desk')).toContain(O)
})

it('sizes a teammate’s terminal as a paired server does, and never holds the owner’s resizes for it', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)
  r.runtime['ptyController']!.resize = () => true
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home, { ownerPtyIds: [owners.ptyId] })
  try {
    // A phone on their terminal keeps its size: no host pane takes it back.
    expect(r.runtime.getMobileDisplayMode(mates.ptyId)).toBe('desktop')
    expect(r.runtime.getMobileDisplayMode(owners.ptyId)).toBe('auto')
    expect(r.runtime['remoteDesktopFloor']['dependencies'].hostShowsTerminal(mates.ptyId)).toBe(
      false
    )
    expect(r.runtime['remoteDesktopFloor']['dependencies'].hostShowsTerminal(owners.ptyId)).toBe(
      true
    )

    // A phone fits the terminal, then a desktop takes it back.
    const fitThenReclaim = async (ptyId: string) => {
      r.runtime['freshSubscribeGuard'].add(ptyId)
      const targets: PtyLayoutTarget[] = [
        { kind: 'phone', cols: 40, rows: 20, ownerClientId: 'mate-phone' },
        { kind: 'desktop', cols: 120, rows: 40 }
      ]
      for (const target of targets) {
        expect(await r.runtime['enqueueLayout'](ptyId, target)).toMatchObject({ ok: true })
      }
      r.runtime['freshSubscribeGuard'].delete(ptyId)
    }
    const before = await probe.ownerState()
    await fitThenReclaim(mates.ptyId)
    expect(r.runtime.isResizeSuppressed()).toBe(false)
    expect(await probe.ownerState()).toBe(before)

    // The owner's own reclaim still holds the window's collateral resizes.
    await fitThenReclaim(owners.ptyId)
    expect(r.runtime.isResizeSuppressed()).toBe(true)
  } finally {
    probe.close()
  }
})
