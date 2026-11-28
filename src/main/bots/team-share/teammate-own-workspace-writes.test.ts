// A teammate's tab writes in a shared agent's Home land in their own workspace on the host, through the
// headless session-tab appliers a paired server runs; their devices keep addressing the Home. Through
// the real dispatcher, runtime and record store, with the owner's window recorded by the probe.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import {
  physicalReload,
  root
} from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { personWorkspaceKey } from '../../../shared/workspace/identity/person-workspace-key'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import { rig, settleTeammateRig, TEAMMATE, type Tabs } from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

type Rig = Awaited<ReturnType<typeof rig>>

function startTerminalsOnTheHost(r: Rig) {
  r.runtime['graphStatus'] = 'ready'
  r.runtime.setPtyController({
    spawn: async ({ sessionId, worktreeId }) => {
      const id = sessionId ?? `${worktreeId}@@${randomUUID()}`
      r.runtime.vouchSpawnedTerminal(id)
      return { id }
    },
    write: () => true,
    kill: (ptyId) => {
      void r.runtime.onPtyExit(ptyId, 0)
      return true
    },
    getForegroundProcess: async () => null
  })
}

const Terminal = z.object({
  tab: z.looseObject({
    id: z.string(),
    parentTabId: z.string(),
    ptyId: z.string(),
    terminal: z.string()
  })
})
const tabIds = (tabs: Tabs) => tabs.tabs.map((tab) => tab.id)

/** `before`: what to open while the host has no window yet (a device's streams). */
async function teammateHome<T = undefined>(before?: (r: Rig) => Promise<T>) {
  const r = await rig()
  startTerminalsOnTheHost(r)
  const K = personWorkspaceKey({ folderWorkspaceId: r.home.slice('folder:'.length), ...TEAMMATE })
  const openTerminal = async (deviceId: string) =>
    Terminal.parse(
      await r.call(deviceId, 'session.tabs.createTerminal', { worktree: `id:${r.home}` })
    ).tab
  // The owner works in the Home too: their own list there is a live one.
  const ownersTerminal = await openTerminal('owner-desk')
  await chatTabCommandsSettled()
  const opened = await before?.(r)
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home, {
    ownerPtyIds: [ownersTerminal.ptyId]
  })
  // A window that just attached is sent the whole held-mail set once, whatever happens next.
  r.runtime['publishHeldWorktrees']()
  await chatTabCommandsSettled()
  probe.relays.length = 0
  return { r, K, probe, openTerminal, ownersTerminal, opened }
}

it("opens a teammate's terminal in their own workspace, shown to their devices as the Home and to no one else", async () => {
  const { r, K, probe, openTerminal, ownersTerminal, opened } = await teammateHome((r) =>
    r.subscribe('mate-phone')
  )
  const matesStream = opened ?? []
  try {
    const before = await probe.ownerState()
    const terminal = await openTerminal('mate-desk')
    await chatTabCommandsSettled()

    // Their stream and census read their own workspace as the Home, once; the owner's never.
    await vi.waitFor(() => expect(tabIds(matesStream.at(-1)!)).toEqual([terminal.id]))
    expect(matesStream.every((frame) => frame.worktree === r.home)).toBe(true)

    const mates = await r.list('mate-phone', `id:${r.home}`)
    expect(mates.worktree).toBe(r.home)
    expect(tabIds(mates)).toEqual([terminal.id])
    expect(r.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs.map((tab) => tab.id)).toEqual([
      terminal.id
    ])
    expect(r.runtime['ptysById'].get(terminal.ptyId)).toMatchObject({
      worktreeId: r.home,
      holder: 'teammate:bot-1:usr_mate'
    })
    expect(tabIds(await r.list('owner-desk', `id:${r.home}`))).toEqual([ownersTerminal.id])
    expect(tabIds(await r.list('other-desk', `id:${r.home}`))).toEqual([])
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("reorders, splits, pins, colors, renames and resizes a teammate's tabs in their own workspace alone, kept across a restart", async () => {
  const { r, K, probe, openTerminal, ownersTerminal } = await teammateHome()
  const groups = z.object({
    tabGroups: z.array(z.object({ id: z.string(), tabOrder: z.array(z.string()) }))
  })
  const first = await openTerminal('mate-desk')
  const second = await openTerminal('mate-phone')
  try {
    await chatTabCommandsSettled()
    const before = await probe.ownerState()
    const worktree = `id:${r.home}`
    const [group] = groups.parse(await r.list('mate-desk', worktree)).tabGroups

    await r.call('mate-desk', 'session.tabs.move', {
      worktree,
      kind: 'reorder',
      tabId: second.id,
      targetGroupId: group!.id,
      tabOrder: [second.parentTabId, first.parentTabId]
    })
    await r.call('mate-desk', 'session.tabs.setTabProps', {
      worktree,
      tabId: first.id,
      isPinned: true,
      color: 'blue',
      customTitle: 'Builds'
    })
    await r.call('mate-desk', 'session.tabs.move', {
      worktree,
      kind: 'split',
      tabId: second.id,
      targetGroupId: group!.id,
      splitDirection: 'right'
    })
    await chatTabCommandsSettled()

    const mates = await r.list('mate-phone', worktree)
    expect(mates.worktree).toBe(r.home)
    expect(groups.parse(mates).tabGroups).toHaveLength(2)
    expect(mates.tabs.find((tab) => tab.id === first.id)).toMatchObject({
      isPinned: true,
      color: 'blue',
      customTitle: 'Builds'
    })
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
    // Saved in the teammates' partition, as a paired server saves its layout.
    const saved = r.profile.getWorkspaceSession('team:homes')
    expect(saved.tabGroups?.[K]).toHaveLength(2)
    expect(saved.tabsByWorktree[K]?.find((tab) => tab.id === first.parentTabId)).toMatchObject({
      isPinned: true,
      color: 'blue',
      customTitle: 'Builds'
    })
  } finally {
    probe.close()
  }
  // A host restart brings their layout back in their own workspace, as a paired server does.
  const fresh = await rig({ opened: await physicalReload(r) })
  const after = await fresh.list('mate-phone', `id:${fresh.home}`)
  expect(after.worktree).toBe(fresh.home)
  expect(groups.parse(after).tabGroups).toHaveLength(2)
  expect(after.tabs.find((tab) => tab.id === first.id)).toMatchObject({
    isPinned: true,
    color: 'blue',
    customTitle: 'Builds'
  })
  expect(tabIds(await fresh.list('owner-desk', `id:${fresh.home}`))).toEqual([ownersTerminal.id])
})

it("brings a teammate's running terminal back into their own workspace after a host restart, never the owner's", async () => {
  const { r, K, probe, openTerminal, ownersTerminal } = await teammateHome()
  probe.close()
  const terminal = await openTerminal('mate-desk')
  await chatTabCommandsSettled()
  // As the spawn's commit saves its pane binding (this rig's daemon commits none).
  const saved = r.profile.getWorkspaceSession('team:homes')
  const layout = saved.terminalLayoutsByTabId[terminal.parentTabId]!
  r.profile.setWorkspaceSession(
    {
      ...saved,
      terminalLayoutsByTabId: {
        ...saved.terminalLayoutsByTabId,
        [terminal.parentTabId]: {
          ...layout,
          ptyIdsByLeafId: { [terminal.id.split('::')[1]!]: terminal.ptyId }
        }
      }
    },
    'team:homes'
  )

  const fresh = await rig({ opened: await physicalReload(r) })
  startTerminalsOnTheHost(fresh)
  // The daemon kept the process: the restarted host reattaches it before anyone reads the Home.
  fresh.runtime.registerPty(terminal.ptyId, fresh.home)
  await chatTabCommandsSettled()

  expect(fresh.runtime['ptysById'].get(terminal.ptyId)?.holder).toBe('teammate:bot-1:usr_mate')
  expect(tabIds(await fresh.list('mate-phone', `id:${fresh.home}`))).toEqual([terminal.id])
  expect(tabIds(await fresh.list('owner-desk', `id:${fresh.home}`))).toEqual([ownersTerminal.id])
  expect(fresh.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs).toHaveLength(1)
})

it("splits a teammate's terminal, resizes its panes and moves one to a new tab, in their own workspace alone", async () => {
  const { r, K, probe, openTerminal } = await teammateHome()
  const terminal = await openTerminal('mate-desk')
  await chatTabCommandsSettled()
  const worktree = `id:${r.home}`
  try {
    const before = await probe.ownerState()
    await r.call('mate-desk', 'terminal.split', {
      terminal: terminal.terminal,
      direction: 'vertical'
    })
    await chatTabCommandsSettled()
    const panes = (await r.list('mate-phone', worktree)).tabs.filter((tab) =>
      tab.id.startsWith(`${terminal.parentTabId}::`)
    )
    expect(panes).toHaveLength(2)
    const leafIds = panes.map((pane) => pane.id.split('::')[1]!)
    await r.call('mate-desk', 'session.tabs.updatePaneLayout', {
      worktree,
      tabId: terminal.parentTabId,
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', leafId: leafIds[0] },
        second: { type: 'leaf', leafId: leafIds[1] }
      }
    })
    expect(
      r.profile.getWorkspaceSession('team:homes').terminalLayoutsByTabId[terminal.parentTabId]?.root
    ).toMatchObject({ type: 'split', ratio: 0.3 })
    await r.call('mate-desk', 'session.tabs.movePaneToNewTab', {
      worktree,
      sourceTabId: terminal.parentTabId,
      targetTabId: 'moved-tab',
      leafId: leafIds[1]
    })
    await chatTabCommandsSettled()

    const mates = await r.list('mate-phone', worktree)
    expect(mates.tabs.map((tab) => tab.id)).toEqual(
      expect.arrayContaining([`moved-tab::${leafIds[1]}`])
    )
    expect(r.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs).toHaveLength(2)
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("starts a teammate's CLI terminal in the Home in their own workspace, and refuses one naming no workspace", async () => {
  const { r, K, probe } = await teammateHome()
  try {
    const before = await probe.ownerState()
    const created = z
      .object({ terminal: z.looseObject({ handle: z.string(), worktreeId: z.string() }) })
      .parse(await r.call('mate-desk', 'terminal.create', { worktree: `id:${r.home}` })).terminal
    await chatTabCommandsSettled()

    expect(created.worktreeId).toBe(r.home)
    expect(r.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs).toHaveLength(1)
    expect((await r.list('mate-phone', `id:${r.home}`)).tabs).toHaveLength(1)
    expect(await r.send('mate-desk', 'terminal.create', {})).toMatchObject({ ok: false })
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("launches a teammate's terminal agents in the Home in their own workspace, never the owner's", async () => {
  const { r, K, probe, ownersTerminal } = await teammateHome()
  try {
    const before = await probe.ownerState()
    for (const method of ['agent.launch', 'agent.launchReplay']) {
      expect(
        await r.send('mate-desk', method, {
          agent: 'codex',
          target: { kind: 'existing', worktree: `id:${r.home}` },
          surface: 'terminal',
          operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`
        }),
        method
      ).toMatchObject({ ok: true })
    }
    expect(
      await r.send('mate-desk', 'terminal.createAgentSession', {
        agent: 'codex',
        worktree: `id:${r.home}`,
        clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`
      })
    ).toMatchObject({ ok: true })
    await chatTabCommandsSettled()

    expect(r.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs).toHaveLength(3)
    expect((await r.list('mate-phone', `id:${r.home}`)).tabs).toHaveLength(3)
    expect(tabIds(await r.list('owner-desk', `id:${r.home}`))).toEqual([ownersTerminal.id])
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("reads and saves a teammate's markdown tab from their own workspace, on the Home's disk", async () => {
  const { r, K, probe } = await teammateHome()
  try {
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes/plan.md'), '# Plan\n')
    const before = await probe.ownerState()
    const worktree = `id:${r.home}`
    const { activeTabId: tabId } = z.object({ activeTabId: z.string() }).parse(
      await r.call('mate-desk', 'session.tabs.openFile', {
        worktree,
        relativePath: 'notes/plan.md'
      })
    )
    expect(r.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs.map((tab) => tab.id)).toEqual([
      tabId
    ])

    const read = z
      .object({ content: z.string(), version: z.string() })
      .parse(await r.call('mate-desk', 'markdown.readTab', { worktree, tabId }))
    expect(read.content).toBe('# Plan\n')
    await r.call('mate-desk', 'markdown.saveTab', {
      worktree,
      tabId,
      baseVersion: read.version,
      content: '# Plan\nShip it\n'
    })
    expect(await readFile(join(root, 'notes/plan.md'), 'utf8')).toBe('# Plan\nShip it\n')
    // The owner's own list has no such tab.
    expect(await r.send('owner-desk', 'markdown.readTab', { worktree, tabId })).toMatchObject({
      ok: false
    })
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("starts a worker from a teammate's terminal in the Home in their own workspace, never the owner's", async () => {
  const { r, K, probe, openTerminal, ownersTerminal } = await teammateHome()
  const asker = await openTerminal('mate-desk')
  await chatTabCommandsSettled()
  try {
    const before = await probe.ownerState()
    // The agent in their terminal asks for a worker, as the CLI there does.
    // Its reply waits on the agent's first report, which this rig's terminals never send.
    void r.send(
      'owner-desk',
      'orchestration.workerStart',
      {
        from: asker.terminal,
        spec: 'Check the build',
        worktree: 'current',
        agent: 'codex'
      },
      undefined,
      ORCHESTRATION_CONTRACT_VERSION
    )
    await vi.waitFor(
      () => expect(r.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs).toHaveLength(2),
      { timeout: 10_000 }
    )
    await chatTabCommandsSettled()

    expect(tabIds(await r.list('owner-desk', `id:${r.home}`))).toEqual([ownersTerminal.id])
    expect(probe.relays).toEqual([])
    expect(await probe.ownerState()).toBe(before)
  } finally {
    probe.close()
  }
})

it("starts a teammate's saved terminal again in their own workspace when they open it after a restart", async () => {
  const { r, K, probe, openTerminal, ownersTerminal } = await teammateHome()
  probe.close()
  const terminal = await openTerminal('mate-desk')
  await chatTabCommandsSettled()

  const fresh = await rig({ opened: await physicalReload(r) })
  startTerminalsOnTheHost(fresh)
  const worktree = `id:${fresh.home}`
  const [pending] = (await fresh.list('mate-phone', worktree)).tabs
  expect(pending).toMatchObject({ id: terminal.id })
  await fresh.call('mate-desk', 'session.tabs.activate', { worktree, tabId: terminal.id })
  await chatTabCommandsSettled()

  const started = [...fresh.runtime['ptysById'].values()].filter((pty) => pty.holder)
  expect(started).toMatchObject([{ worktreeId: fresh.home, holder: 'teammate:bot-1:usr_mate' }])
  expect(fresh.runtime['mobileSessionTabsByWorktree'].get(K)?.tabs).toHaveLength(1)
  expect(tabIds(await fresh.list('owner-desk', worktree))).toEqual([ownersTerminal.id])
})
