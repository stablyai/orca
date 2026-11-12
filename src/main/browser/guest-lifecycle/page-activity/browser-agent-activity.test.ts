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
import { runWithActiveRpcCaller } from '../../../runtime/rpc/callers/active-call'
import {
  BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL,
  BROWSER_AGENT_CURSOR_CHANNEL,
  type BrowserAgentCursorEvent
} from '../../../../shared/browser-agent-activity-contract'

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
})
