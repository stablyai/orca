// An agent in a teammate's own terminal in a shared agent's Home reports to their devices alone: the
// owner's window hears none of it, pushed live or pulled on load, and the owner's own agents still
// reach it. Through the real runtime, hook server, window relay and IPC handlers; the host's PTY
// daemon and the provider's spawn-time pane binding are the only stand-ins.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { installMainWindowAgentStatusListeners } from '../../startup/main-window/main-window-agent-status'
import { mainProcessState } from '../../startup/main-process-state'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server/server-types'
import { paneKeyPtyId } from '../../ipc/pty/pane/key-state'
import { registerAgentHookHandlers } from '../../ipc/agent-hooks/agent-hooks'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import { rig, settleTeammateRig } from './teammate-tabs.test-support'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
    on: () => {},
    removeListener: () => {},
    removeAllListeners: () => {}
  }
}))

afterEach(async () => {
  agentHookServer.setListener(null)
  agentHookServer.setPaneStatusClearListener(null)
  paneKeyPtyId.clear()
  await settleTeammateRig()
})

type Rig = Awaited<ReturnType<typeof rig>>

/** The host's terminals start as the desktop's do, each a live process under the id it asked for. */
function startTerminalsOnTheHost(r: Rig, onKill: (ptyId: string) => void) {
  r.runtime['graphStatus'] = 'ready'
  r.runtime.setPtyController({
    spawn: async ({ sessionId, worktreeId }) => {
      const id = sessionId ?? `${worktreeId}@@${randomUUID()}`
      r.runtime.vouchSpawnedTerminal(id)
      return { id }
    },
    write: () => true,
    kill: (ptyId) => (onKill(ptyId), true),
    getForegroundProcess: async () => null
  })
}

const Terminal = z.object({ tab: z.looseObject({ id: z.string(), ptyId: z.string() }) })

/** A terminal a device opens, bound to its pane as the provider binds a spawn. */
async function openTerminal(r: Rig, deviceId: string) {
  const { tab } = Terminal.parse(
    await r.call(deviceId, 'session.tabs.createTerminal', { worktree: `id:${r.workspace}` })
  )
  const [tabId, leafId] = tab.id.split('::')
  const paneKey = makePaneKey(tabId!, leafId!)
  paneKeyPtyId.set(paneKey, tab.ptyId)
  return { ...tab, tabId: tabId!, paneKey }
}

/** The owner's window open on the host, wired as the desktop wires its agent-status relay. */
async function besideOwnersWindow(r: Rig) {
  const probe = ownerWindowProbe(r.runtime, r.profile, r.home)
  const previous = mainProcessState.mainWindow
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay reads only the window's id and isDestroyed.
  mainProcessState.mainWindow = { id: 1, isDestroyed: () => false } as typeof previous
  const previousRuntime = mainProcessState.core.runtime
  mainProcessState.core.runtime = r.runtime
  installMainWindowAgentStatusListeners({
    window: mainProcessState.mainWindow!,
    onRecordAgentState: () => {}
  })
  // Installing a window sends it the host's sleeping mail; the acts below start after that.
  await chatTabCommandsSettled()
  probe.relays.splice(0)
  return {
    probe,
    before: await probe.ownerState(),
    close: () => {
      mainProcessState.mainWindow = previous
      mainProcessState.core.runtime = previousRuntime
      probe.close()
    }
  }
}

/** A hook reporting that the agent in this terminal finished. */
function finished(r: Rig, terminal: { tabId: string; paneKey: string }): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a hook's finished row, with the fields the relay reads.
  const row = {
    paneKey: terminal.paneKey,
    tabId: terminal.tabId,
    worktreeId: r.workspace,
    payload: { state: 'done', agentType: 'claude', prompt: '' },
    receivedAt: Date.now(),
    stateStartedAt: Date.now()
  } as unknown as EnrichedAgentHookEventPayload
  agentHookServer['onAgentStatus']?.(row)
}

it('keeps a teammate’s agent finishing off the owner’s window, sidebar record and notifications', async () => {
  const r = await rig()
  startTerminalsOnTheHost(r, (ptyId) => void r.runtime.onPtyExit(ptyId, 0))
  const ownersTerminal = await openTerminal(r, 'owner-desk')
  const matesTerminal = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  const owner = await besideOwnersWindow(r)
  try {
    finished(r, matesTerminal)
    agentHookServer['onPaneStatusCleared']?.({ paneKey: matesTerminal.paneKey })
    await chatTabCommandsSettled()
    expect(owner.probe.relays).toEqual([])
    expect(await owner.probe.ownerState()).toBe(owner.before)

    finished(r, ownersTerminal)
    agentHookServer['onPaneStatusCleared']?.({ paneKey: ownersTerminal.paneKey })
    expect(owner.probe.relays.map((relay) => relay.name)).toEqual([
      'sendToWindow:agentStatus:set',
      'sendToWindow:agentStatus:clear'
    ])
  } finally {
    owner.close()
  }
})

it('keeps the clear of a teammate’s terminal they closed off the owner’s window', async () => {
  const r = await rig()
  // A killed process exits later; its pane's status clears as it does, before the runtime hears it.
  const killed: string[] = []
  startTerminalsOnTheHost(r, (ptyId) => killed.push(ptyId))
  const matesTerminal = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  const owner = await besideOwnersWindow(r)
  try {
    await r.call('mate-desk', 'session.tabs.close', {
      worktree: `id:${r.workspace}`,
      tabId: matesTerminal.id,
      reason: 'user'
    })
    expect(killed).toEqual([matesTerminal.ptyId])
    agentHookServer['onPaneStatusCleared']?.({ paneKey: matesTerminal.paneKey })
    expect(owner.probe.relays).toEqual([])
  } finally {
    owner.close()
  }
})

it('leaves a teammate’s agent out of the statuses the owner’s window pulls on load', async () => {
  const r = await rig()
  startTerminalsOnTheHost(r, (ptyId) => void r.runtime.onPtyExit(ptyId, 0))
  const ownersTerminal = await openTerminal(r, 'owner-desk')
  const matesTerminal = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  registerAgentHookHandlers(r.runtime)
  const rows = [ownersTerminal, matesTerminal].map((terminal) => ({
    paneKey: terminal.paneKey,
    worktreeId: r.workspace,
    payload: { state: 'done', agentType: 'claude' }
  }))
  vi.spyOn(agentHookServer, 'getStatusSnapshot').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pull reads only these fields.
    rows as unknown as ReturnType<typeof agentHookServer.getStatusSnapshot>
  )

  const pulled = z
    .array(z.looseObject({ paneKey: z.string() }))
    .parse(handlers.get('agentStatus:getSnapshot')?.())
  expect(pulled.map((row) => row.paneKey)).toEqual([ownersTerminal.paneKey])
})

it('keeps a teammate’s agent terminal and its launch recipe off the owner’s window', async () => {
  const r = await rig()
  startTerminalsOnTheHost(r, (ptyId) => void r.runtime.onPtyExit(ptyId, 0))
  const owner = await besideOwnersWindow(r)
  const launch = (deviceId: string) =>
    r.call(deviceId, 'session.tabs.createTerminal', {
      worktree: `id:${r.workspace}`,
      agent: 'claude'
    })
  try {
    await launch('mate-desk')
    await chatTabCommandsSettled()
    expect(owner.probe.relays).toEqual([])
    // The owner's own opens in the window, as the window owns the layout.
    await launch('owner-desk')
    expect(owner.probe.relays.map((relay) => relay.name)).toEqual(['revealTerminalSession'])
  } finally {
    owner.close()
  }
})
