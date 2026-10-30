import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcListeners, windowState } = vi.hoisted(() => ({
  ipcListeners: new Map<string, ((event: unknown, reply: unknown) => void)[]>(),
  windowState: { visible: true }
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, listener: (event: unknown, reply: unknown) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener])
    })
  },
  BrowserWindow: {
    fromWebContents: () => ({
      isDestroyed: () => false,
      isVisible: () => windowState.visible,
      isMinimized: () => false
    })
  }
}))

import { BrowserAgentActivity } from './browser-agent-activity'
import { runWithActiveRpcCaller } from '../runtime/rpc/rpc-active-caller'
import {
  BROWSER_AGENT_ACTIVITY_CHANNEL,
  BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL,
  BROWSER_AGENT_CURSOR_CHANNEL,
  type BrowserAgentCursorEvent
} from '../../shared/browser-agent-activity-contract'

const PAGE = 'page-1'

function setup() {
  const sent: { channel: string; data: unknown }[] = []
  const renderer = {
    id: 7,
    isDestroyed: () => false,
    send: vi.fn((channel: string, data: unknown) => sent.push({ channel, data }))
  }
  const guest = {
    id: 42,
    isDestroyed: () => false,
    isCrashed: () => false,
    debugger: {
      sendCommand: vi.fn(async () => ({ result: { value: [1000, 800] } }))
    }
  }
  const activity = new BrowserAgentActivity({
    pageIdForGuest: (id) => (id === guest.id ? PAGE : null),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner reads only id, isDestroyed and send.
    rendererForPage: () => renderer as unknown as Electron.WebContents,
    worktreeForPage: () => 'wt-1'
  })
  const agentCommand = () =>
    runWithActiveRpcCaller({ kind: 'local-cli' }, () => activity.beginCommand(PAGE))
  const cursorEvents = () =>
    sent
      .filter((entry) => entry.channel === BROWSER_AGENT_CURSOR_CHANNEL)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only cursor events are sent on this channel.
      .map((entry) => entry.data as BrowserAgentCursorEvent)
  const arrive = (sequence: number, senderId = renderer.id) => {
    for (const listener of ipcListeners.get(BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL) ?? []) {
      listener({ sender: { id: senderId } }, { sequence })
    }
  }
  const show = (input: Record<string, unknown>) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner reads only id and debugger.sendCommand.
    activity.showPointer(guest as unknown as Electron.WebContents, input)
  return { activity, sent, agentCommand, cursorEvents, arrive, show }
}

describe('BrowserAgentActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ipcListeners.clear()
    windowState.visible = true
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks pages only for an agent CLI caller, never for relayed user input', () => {
    const { activity, sent } = setup()
    runWithActiveRpcCaller({ kind: 'paired-device', deviceId: 'phone' }, () =>
      activity.beginCommand(PAGE)
    ).end()
    activity.beginCommand(PAGE).end()
    expect(sent).toEqual([])
  })

  it('clears the mark once the agent stays idle, and at once when the page closes', () => {
    const { activity, sent, agentCommand } = setup()
    agentCommand().end()
    expect(sent).toEqual([
      {
        channel: BROWSER_AGENT_ACTIVITY_CHANNEL,
        data: { browserPageId: PAGE, worktreeId: 'wt-1', active: true }
      }
    ])
    vi.advanceTimersByTime(19_000)
    agentCommand().end()
    vi.advanceTimersByTime(19_000)
    expect(sent.at(-1)?.data).toEqual({ browserPageId: PAGE, worktreeId: 'wt-1', active: true })
    vi.advanceTimersByTime(1_000)
    expect(sent.at(-1)?.data).toEqual({ browserPageId: PAGE, worktreeId: 'wt-1', active: false })

    agentCommand()
    activity.end(PAGE)
    expect(sent.at(-1)?.data).toEqual({ browserPageId: PAGE, worktreeId: 'wt-1', active: false })
  })

  it('hands an agent claim to the page it continues on, which then idles out like any other', () => {
    const { activity, agentCommand } = setup()
    activity.handOver(PAGE, 'opener')
    expect(activity.isActive('opener')).toBe(false)

    agentCommand().end()
    activity.handOver(PAGE, 'opener')
    expect(activity.isActive('opener')).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(activity.isActive('opener')).toBe(false)
  })

  it('holds a fresh move until the renderer reports the cursor landed', async () => {
    const { agentCommand, cursorEvents, arrive, show } = setup()
    let landed = false
    const shown = agentCommand()
      .run(() => show({ type: 'mouseMoved', x: 100, y: 50, buttons: 0 }))
      .then(() => {
        landed = true
      })
    await vi.advanceTimersByTimeAsync(0)
    const [event] = cursorEvents()
    expect(event).toMatchObject({ x: 100, y: 50, viewportWidth: 1000, awaitsArrival: true })
    arrive(event.sequence, 99)
    await vi.advanceTimersByTimeAsync(0)
    expect(landed).toBe(false)
    arrive(event.sequence)
    await shown
    expect(landed).toBe(true)
  })

  it('stops waiting after the timeout, or when the page closes', async () => {
    const { activity, agentCommand, show } = setup()
    const timedOut = agentCommand().run(() => show({ type: 'mouseMoved', x: 1, y: 1 }))
    await vi.advanceTimersByTimeAsync(1500)
    await expect(timedOut).resolves.toBeUndefined()

    const closed = agentCommand().run(() => show({ type: 'mouseMoved', x: 2, y: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    activity.end(PAGE)
    await expect(closed).resolves.toBeUndefined()
  })

  it('never waits for presses, drag steps, or a window nobody can see', async () => {
    const { agentCommand, cursorEvents, show } = setup()
    await agentCommand().run(async () => {
      await show({ type: 'mousePressed', x: 5, y: 5 })
      await show({ type: 'mouseMoved', x: 6, y: 5, buttons: 1 })
      windowState.visible = false
      await show({ type: 'mouseMoved', x: 300, y: 300 })
    })
    expect(cursorEvents().map((event) => event.awaitsArrival)).toEqual([false, false, false])
    expect(cursorEvents()[0].press).toBe(true)
  })

  it('draws no cursor for input that runs while agent commands only wait in the queue', async () => {
    const { agentCommand, cursorEvents, show } = setup()
    const queuedAgentCommand = agentCommand()
    await show({ type: 'mouseMoved', x: 40, y: 40 })
    expect(cursorEvents()).toEqual([])
    queuedAgentCommand.end()
  })
})
