import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { QUERY_RESPONDER_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import type { DaemonServer } from './daemon-server'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type { PtyBackgroundStreamEvent } from '../providers/types'
import { _resetDaemonTerminalViewAttributesForTest } from './daemon-view-attributes'

describe('DaemonPtyAdapter query responder delegation', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let subprocesses: ReturnType<typeof createMockSubprocess>[]

  beforeEach(async () => {
    subprocesses = []
    const harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
    _resetDaemonTerminalViewAttributesForTest()
  })

  function markers(events: PtyBackgroundStreamEvent[]): boolean[] {
    return events.flatMap((event) =>
      event.kind === 'queryResponderMarker' ? [event.responder] : []
    )
  }

  it('delegates replies to the daemon between its in-order markers', async () => {
    const events: PtyBackgroundStreamEvent[] = []
    adapter.onBackgroundStreamEvent((event) => events.push(event))
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    const subprocess = subprocesses[0]
    expect(adapter.canDelegateQueryResponder(id)).toBe(true)

    expect(adapter.setSessionQueryResponder(id, true)).toBe(true)
    await waitFor(() => markers(events).length === 1)
    subprocess._simulateData('x\x1b[6n')
    await waitFor(() => subprocess.write.mock.calls.length > 0)
    expect(subprocess.write).toHaveBeenCalledWith('\x1b[1;2R')

    expect(adapter.setSessionQueryResponder(id, false)).toBe(true)
    await waitFor(() => markers(events).length === 2)
    expect(markers(events)).toEqual([true, false])
  })

  it('reports a reattach as a take-back, since the daemon drops delegations on attach', async () => {
    const events: PtyBackgroundStreamEvent[] = []
    adapter.onBackgroundStreamEvent((event) => events.push(event))
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    adapter.setSessionQueryResponder(id, true)
    await waitFor(() => markers(events).length === 1)

    adapter['releaseQueryResponderSessions']()

    expect(events.at(-1)).toEqual({ id, kind: 'queryResponderMarker', responder: false })
    adapter['releaseQueryResponderSessions']()
    expect(markers(events)).toEqual([true, false])
  })

  it('never delegates to a daemon older than the responder protocol', () => {
    const legacy = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      protocolVersion: QUERY_RESPONDER_DAEMON_PROTOCOL_VERSION - 1
    })
    const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
    try {
      legacy['activeSessionIds'].add('session-a')
      expect(legacy.canDelegateQueryResponder('session-a')).toBe(false)
      expect(legacy.setSessionQueryResponder('session-a', true)).toBe(false)
      legacy.setTerminalViewAttributes({
        foreground: [1, 1, 1],
        background: [0, 0, 0],
        cursor: [1, 1, 1],
        ansi: [],
        colorSchemeMode: 'dark',
        cursorStyle: 'block',
        cursorBlink: false
      })
      expect(notifySpy).not.toHaveBeenCalled()
      expect(adapter.canDelegateQueryResponder('never-spawned-session')).toBe(false)
    } finally {
      notifySpy.mockRestore()
      legacy.dispose()
    }
  })
})
