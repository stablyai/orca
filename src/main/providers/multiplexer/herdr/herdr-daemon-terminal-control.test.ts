import { describe, expect, it, vi } from 'vitest'
import type { HerdrTerminalFrame } from './herdr-runtime-contract'
import {
  createHerdrDaemonTerminalController,
  type HerdrDaemonPaneData
} from './herdr-daemon-terminal-control'
import type { HerdrSocketEvent, PaneReadWireResponse } from './herdr-socket-types'

function wire(text: string, revision: number): PaneReadWireResponse {
  return { type: 'pane_read', read: { text, revision } } as PaneReadWireResponse
}

function setup(opts: { readRevision?: number; readText?: string } = {}) {
  const requests: { method: string; params: Record<string, unknown> }[] = []
  let paneDataListener: ((payload: HerdrDaemonPaneData) => void) | null = null
  let eventListener: ((event: HerdrSocketEvent) => void) | null = null

  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params })
    if (method === 'pane.read') {
      return wire(opts.readText ?? 'prompt$ ', opts.readRevision ?? 0)
    }
    return undefined
  })

  const controller = createHerdrDaemonTerminalController(
    'pane-1',
    { cols: 80, rows: 24 },
    {
      request: request as never,
      subscribePaneData: (listener) => {
        paneDataListener = listener
        return () => {
          paneDataListener = null
        }
      },
      subscribeEvents: (listener) => {
        eventListener = listener
        return () => {
          eventListener = null
        }
      }
    }
  )

  const frames: HerdrTerminalFrame[] = []
  controller.onFrame((frame) => frames.push(frame))

  const paneData = (payload: HerdrDaemonPaneData): void => paneDataListener?.(payload)
  const event = (name: string, data: Record<string, unknown> = {}): void =>
    eventListener?.({ event: name, data: { type: name, ...data } })

  return { controller, request, requests, frames, paneData, event }
}

function decode(frame: HerdrTerminalFrame): string {
  return Buffer.from(frame.bytes, 'base64').toString('utf8')
}

describe('createHerdrDaemonTerminalController', () => {
  it('seeds a full frame from pane.read then streams incremental frames', async () => {
    const { frames, paneData } = setup({ readRevision: 0, readText: 'prompt$ ' })

    await vi.waitFor(() => {
      expect(frames.length).toBe(1)
    })
    expect(frames[0].full).toBe(true)
    expect(decode(frames[0])).toBe('prompt$ ')

    paneData({ pane_id: 'pane-1', data: 'e', sequence_chars: 1 })
    paneData({ pane_id: 'pane-1', data: 'c', sequence_chars: 2 })

    expect(frames).toHaveLength(3)
    expect(frames[1].full).toBe(false)
    expect(decode(frames[1])).toBe('e')
    expect(decode(frames[2])).toBe('c')
  })

  it('buffers pane.data that arrives before the seed and replays only newer chunks', async () => {
    let resolveRead: (value: PaneReadWireResponse) => void = () => {}
    const request = vi.fn(
      (method: string) =>
        new Promise((resolve) => {
          if (method === 'pane.read') {
            resolveRead = resolve as never
          } else {
            resolve(undefined)
          }
        })
    )
    const frames: HerdrTerminalFrame[] = []
    let paneDataListener: ((payload: HerdrDaemonPaneData) => void) | null = null
    const controller = createHerdrDaemonTerminalController(
      'pane-1',
      { cols: 80, rows: 24 },
      {
        request: request as never,
        subscribePaneData: (listener) => {
          paneDataListener = listener
          return () => {
            paneDataListener = null
          }
        },
        subscribeEvents: () => () => {}
      }
    )
    controller.onFrame((frame) => frames.push(frame))
    const paneData = (payload: HerdrDaemonPaneData): void => paneDataListener?.(payload)

    paneData({ pane_id: 'pane-1', data: 'a', sequence_chars: 1 })
    paneData({ pane_id: 'pane-1', data: 'b', sequence_chars: 2 })

    resolveRead(wire('prompt$ a', 1))

    await vi.waitFor(() => {
      expect(frames.length).toBe(2)
    })
    expect(frames[0].full).toBe(true)
    expect(decode(frames[0])).toBe('prompt$ a')
    expect(decode(frames[1])).toBe('b')
  })

  it('ignores pane.data for other panes and dedups chunks at or below the seed revision', async () => {
    const { frames, paneData } = setup({ readRevision: 5, readText: 'p$ ' })

    await vi.waitFor(() => {
      expect(frames.length).toBe(1)
    })

    paneData({ pane_id: 'other-pane', data: 'x', sequence_chars: 9 })
    paneData({ pane_id: 'pane-1', data: 'old', sequence_chars: 5 })
    paneData({ pane_id: 'pane-1', data: 'new', sequence_chars: 6 })

    expect(frames).toHaveLength(2)
    expect(decode(frames[1])).toBe('new')
  })

  it('routes write and resize to the daemon', async () => {
    const { controller, requests } = setup()

    controller.write('ls\r')
    controller.resize(120, 40)

    await vi.waitFor(() => {
      expect(requests.some((r) => r.method === 'pane.send_text')).toBe(true)
    })
    expect(requests).toContainEqual({
      method: 'pane.send_text',
      params: { pane_id: 'pane-1', text: 'ls\r' }
    })
    expect(requests).toContainEqual({
      method: 'pane.resize',
      params: { pane_id: 'pane-1', cols: 120, rows: 40 }
    })
  })

  it('emits closed on pane.exited and stops after release', async () => {
    const { controller, frames, paneData, event } = setup({ readRevision: 0, readText: 'p$ ' })
    const closed: string[] = []
    controller.onClosed((close) => closed.push(close.reason))

    await vi.waitFor(() => {
      expect(frames.length).toBe(1)
    })

    event('pane.exited', { pane_id: 'pane-1' })
    expect(closed).toEqual(['pane_exited'])

    controller.release()
    const count = frames.length
    paneData({ pane_id: 'pane-1', data: 'z', sequence_chars: 99 })
    expect(frames.length).toBe(count)
  })
})
