// A teammate's own terminals in a shared agent's Home: their workspace-wide acts take their own list,
// and nothing their terminals do (bells, finished agents, sizes) reaches the owner. Through the real
// dispatcher, runtime and record store; the host's PTY daemon is the only stand-in.
import { afterEach, expect, it, vi } from 'vitest'
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
  SCOPE,
  startTerminalsOnTheHost,
  TEAMMATE
} from './teammate-tabs.test-support'
import { randomUUID } from 'node:crypto'
import { spawnWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { teammateTabListKey } from './teammate-rules'
import { personWorkspaceKey } from '../../../shared/workspace/identity/person-workspace-key'
import { TEAMMATE_HOMES_SESSION_PARTITION as TEAM } from '../../../shared/workspace-session/teammate-homes-session-partition'

afterEach(settleTeammateRig)

type Rig = Awaited<ReturnType<typeof rig>>

const SCOPE_LIST = teammateTabListKey(SCOPE)

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
    // Sleeping the whole workspace stays the owner's.
    expect(await r.send('mate-desk', 'worktree.sleep', { worktree })).toMatchObject({ ok: false })
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

it('sleeps a teammate’s own terminals alone, telling only their devices', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)
  const worktree = `id:${r.workspace}`
  // The daemon lists its live processes, and a sleep's stop waits for the exit.
  r.runtime['ptyController'] = {
    ...r.runtime['ptyController']!,
    listProcesses: async () =>
      [...r.runtime['ptysById'].values()]
        .filter((pty) => pty.connected)
        .map((pty) => ({ id: pty.ptyId, cwd: '', title: '' })),
    stopAndWait: async (ptyId) => {
      await r.runtime.onPtyExit(ptyId, 0)
      return true
    }
  }
  const sleepEvents = (deviceId: string) => {
    const replies = r.stream(deviceId, 'runtime.clientEvents.subscribe', {})
    return () =>
      replies.flatMap((reply) => {
        const event = z.object({ result: z.looseObject({ type: z.string() }) }).safeParse(reply)
          .data?.result
        return event?.type === 'worktreeTerminalSleepState' ? [event] : []
      })
  }
  // Mate's terminal runs a resumable agent, as K's saved tabs hold it; its record is captured as
  // the hook store tells it (the one read stood in for).
  const K = personWorkspaceKey({ folderWorkspaceId: r.home.slice('folder:'.length), ...TEAMMATE })
  const [matesTabId, matesLeafId] = mates.id.split('::')
  const matesPane = makePaneKey(matesTabId!, matesLeafId!)
  r.profile.setWorkspaceSession(
    {
      ...r.profile.getWorkspaceSession(TEAM),
      tabsByWorktree: {
        [K]: [
          {
            id: matesTabId!,
            ptyId: mates.ptyId,
            worktreeId: K,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    },
    TEAM
  )
  const recorder = r.runtime['sleepResumeRecords']
  const capture = recorder.capture.bind(recorder)
  recorder.capture = async (worktreeId, ptyIds) => {
    const captured = await capture(worktreeId, ptyIds)
    captured.set(mates.ptyId, {
      retiredPaneKeys: [],
      records: [
        {
          paneKey: matesPane,
          tabId: matesTabId!,
          worktreeId,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'claude-session-1' },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'worktree-sleep',
          restoreOnTabOpenOnly: true,
          connectionId: null
        }
      ]
    })
    return captured
  }
  const owners$ = sleepEvents('owner-desk')
  const ownersPhone$ = sleepEvents('owner-phone')
  const mates$ = sleepEvents('mate-desk')
  const others$ = sleepEvents('other-desk')
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home, { ownerPtyIds: [owners.ptyId] })
  try {
    const before = await probe.ownerState()
    expect(await r.call('mate-desk', 'terminal.sleep', { worktree })).toMatchObject({
      stoppedPtyIds: [mates.ptyId]
    })
    await chatTabCommandsSettled()
    expect(live(r, mates.ptyId)).toBe(false)
    expect(live(r, owners.ptyId)).toBe(true)
    // Their devices hear it as the Home they address; no one else hears of it.
    await vi.waitFor(() =>
      expect(mates$()).toContainEqual(
        expect.objectContaining({ worktreeId: r.home, phase: 'committed', ptyIds: [mates.ptyId] })
      )
    )
    expect(mates$().every((event) => event.worktreeId === r.home)).toBe(true)
    expect([...owners$(), ...ownersPhone$(), ...others$()]).toEqual([])
    // A device that subscribes later is told the same way.
    const late = sleepEvents('owner-desk')
    const matesLate = sleepEvents('mate-phone')
    await vi.waitFor(() => expect(matesLate()).not.toEqual([]))
    expect(late()).toEqual([])
    // Its resume record is saved in K, in the teammates' partition, never the owner's session.
    expect(
      r.profile.getWorkspaceSession(TEAM).sleepingAgentSessionsByPaneKey?.[matesPane]
    ).toMatchObject({ worktreeId: K, agent: 'claude' })
    expect(probe.relays.filter((relay) => relay.via !== 'window')).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }

  // A new terminal in the owner's list leaves Mate's list asleep; one in Mate's wakes it alone.
  const sleepKeys = () => [...r.runtime['terminalSleepStateByHostWorktree'].keys()]
  const home = spawnWorktreeTarget(r.workspace, null)
  ;(await r.runtime.acquireWorktreeTerminalSpawn(home))()
  expect(sleepKeys()).toEqual([`local|${K}`])
  ;(await r.runtime.acquireWorktreeTerminalSpawn(home, { list: SCOPE_LIST }))()
  expect(sleepKeys()).toEqual([])
  await vi.waitFor(() =>
    expect(mates$()).toContainEqual(expect.objectContaining({ phase: 'woken' }))
  )

  // Closing all of Mate's terminals drops their slept record from the teammates' partition.
  r.profile.setWorkspaceSession(
    { ...r.profile.getWorkspaceSession(TEAM), tabsByWorktree: {} },
    TEAM
  )
  await r.call('mate-desk', 'terminal.closeAll', { worktree })
  expect(r.profile.getWorkspaceSession(TEAM).sleepingAgentSessionsByPaneKey?.[matesPane]).toBe(
    undefined
  )

  // The owner's sleep takes the host list's alone, as before; only their devices hear it, and an
  // owner's spawn wakes it while a teammate's does not.
  await r.call('owner-desk', 'terminal.sleep', { worktree })
  expect(live(r, owners.ptyId)).toBe(false)
  await vi.waitFor(() =>
    expect(owners$()).toContainEqual(
      expect.objectContaining({ worktreeId: r.workspace, ptyIds: [owners.ptyId] })
    )
  )
  expect(JSON.stringify(mates$())).not.toContain(owners.ptyId)
  expect(others$()).toEqual([])
  ;(await r.runtime.acquireWorktreeTerminalSpawn(home, { list: SCOPE_LIST }))()
  expect(sleepKeys()).toHaveLength(1)
  ;(await r.runtime.acquireWorktreeTerminalSpawn(home))()
  expect(sleepKeys()).toEqual([])
})

it('tells only a terminal’s own list’s devices of its bells and titles', async () => {
  const r = await rig()
  const { owners, mates } = await bothTerminals(r)
  const sideEffects = (deviceId: string) => {
    const replies = r.stream(deviceId, 'runtime.clientEvents.subscribe', {})
    return () =>
      replies.flatMap((reply) => {
        const event = z
          .object({
            result: z.looseObject({ type: z.string(), batch: z.looseObject({ ptyId: z.string() }) })
          })
          .safeParse(reply).data?.result
        return event?.type === 'terminalSideEffects' ? [event.batch.ptyId] : []
      })
  }
  const owners$ = sideEffects('owner-desk')
  const others$ = sideEffects('other-desk')
  await vi.waitFor(() =>
    expect(r.runtime['countTerminalSideEffectConsumingClientEventListeners']()).toBeGreaterThan(1)
  )
  for (const ptyId of [mates.ptyId, owners.ptyId]) {
    r.runtime.onPtyData(ptyId, '\x1b]0;Build\x1b\\\x07', Date.now())
  }
  await vi.waitFor(() => expect(owners$()).toContain(owners.ptyId))
  expect(owners$()).not.toContain(mates.ptyId)
  expect(others$()).not.toContain(mates.ptyId)
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

    // A pane no list places (its terminal gone, say) is no one's news.
    const strayPane = makePaneKey(randomUUID(), randomUUID())
    hooks.report({ paneKey: strayPane, worktreeId: r.workspace, state: 'working' })
    expect(everyPane).toContain(strayPane)
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
    const relays = probe.relays.length
    await fitThenReclaim(mates.ptyId)
    expect(r.runtime.isResizeSuppressed()).toBe(false)
    // The window hears nothing of a fit of a terminal it does not show.
    expect(probe.relays.slice(relays)).toEqual([])
    expect(await probe.ownerState()).toBe(before)

    // The owner's own reclaim still holds the window's collateral resizes.
    await fitThenReclaim(owners.ptyId)
    expect(r.runtime.isResizeSuppressed()).toBe(true)

    // A paired desktop sizes the terminal, then leaves it: only the owner's goes back to the host's size.
    const viewThenLeave = async (ptyId: string) => {
      r.runtime['freshSubscribeGuard'].add(ptyId)
      await r.runtime.updateRemoteDesktopViewer(ptyId, `sub-${ptyId}`, 'desk', 100, 30)
      await r.runtime.unregisterRemoteDesktopViewer(ptyId, `sub-${ptyId}`)
      r.runtime['freshSubscribeGuard'].delete(ptyId)
      return r.runtime['layouts'].get(ptyId)?.kind
    }
    expect(await viewThenLeave(mates.ptyId)).toBe('remote-desktop')
    expect(await viewThenLeave(owners.ptyId)).toBe('desktop')
  } finally {
    probe.close()
  }
})
