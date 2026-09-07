import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDialStageTracker } from './relay-dial-stage'
import type { ConnectionLogEntry } from './types'

const fakes = vi.hoisted(() => ({
  linkOptions: null as null | {
    onOpen(): void
    onHello(value: unknown): void
    onAuthenticated(): void
    onText(value: string): void
    onBinary(value: Uint8Array): void
    onError(error: Error): void
  },
  sendText: vi.fn(() => true),
  close: vi.fn()
}))

vi.mock('./mobile-relay-e2ee-link', () => ({
  MobileRelayE2eeLink: class {
    constructor(options: NonNullable<typeof fakes.linkOptions>) {
      fakes.linkOptions = options
    }
    sendText = fakes.sendText
    close = fakes.close
  }
}))

import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

function openSession(entries: ConnectionLogEntry[]) {
  return connectMobileRelayRpcSession({
    relay,
    resumeToken: 'resume-secret',
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'confirm-1',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requestTimeoutMs: 1000,
    onLog: (entry) => entries.push(entry)
  })
}

function stageTimings(entries: readonly ConnectionLogEntry[]) {
  return entries.flatMap((entry) =>
    entry.timing?.kind === 'relay-dial-stage' ? [entry.timing] : []
  )
}

describe('RelayDialStageTracker timings', () => {
  it('times every stage it passes through without going negative', () => {
    // A clock that steps backwards proves the report can never show a negative stage.
    const reads = [0, 120, 4_400, 4_300, 5_500]
    let index = 0
    const tracker = new RelayDialStageTracker(() => reads[index++]!)

    expect(tracker.advance('awaiting-hello')).toEqual({
      stage: 'opening',
      ms: 120,
      complete: true
    })
    expect(tracker.advance('handshaking')).toEqual({
      stage: 'awaiting-hello',
      ms: 4_280,
      complete: true
    })
    expect(tracker.advance('confirming')).toEqual({
      stage: 'handshaking',
      ms: 0,
      complete: true
    })
    expect(tracker.settle(true)).toEqual({ stage: 'confirming', ms: 1_200, complete: true })
    expect(tracker.getDialStage()).toBe('confirming')
  })

  it('re-advancing to the current stage is not a transition', () => {
    const tracker = new RelayDialStageTracker(() => 0)
    expect(tracker.advance('opening')).toBeNull()
  })

  it('settles once, so a failure after connecting cannot re-time the last stage', () => {
    let now = 0
    const tracker = new RelayDialStageTracker(() => now)
    tracker.advance('awaiting-hello')
    now = 900
    expect(tracker.settle(true)).toEqual({ stage: 'awaiting-hello', ms: 900, complete: true })
    now = 90_000
    expect(tracker.settle(false)).toBeNull()
  })
})

function requestIdAt(call: number): string {
  return (JSON.parse(fakes.sendText.mock.calls[call]![0] as string) as { id: string }).id
}

describe('relay dial stage timings in the connection log', () => {
  beforeEach(() => {
    fakes.sendText.mockClear()
    fakes.close.mockClear()
  })

  it('records the stages a failed dial reached plus the stage it died in', () => {
    const entries: ConnectionLogEntry[] = []
    openSession(entries)
    fakes.linkOptions!.onOpen()
    fakes.linkOptions!.onError(new Error('relay dial failed'))

    const timings = stageTimings(entries)
    expect(timings.map((timing) => timing.name)).toEqual(['opening', 'awaiting-hello'])
    expect(timings.map((timing) => timing.complete)).toEqual([true, false])
    for (const timing of timings) {
      expect(timing.ms).toBeGreaterThanOrEqual(0)
    }
    expect(entries.at(-1)!.message).toContain('awaiting-hello did not finish')
    expect(entries.at(-1)!.detail).toContain('relay dial failed')
    expect(entries.at(-1)!.path).toBe('relay')
  })

  it('records every stage of a dial that reaches connected, all complete', async () => {
    const entries: ConnectionLogEntry[] = []
    const session = openSession(entries)
    fakes.linkOptions!.onOpen()
    fakes.linkOptions!.onHello({
      type: 'relay-hello',
      ok: true,
      credentialKind: 'resume',
      leaseExpiresAt: Date.now() + 60_000,
      acceptedCredentialVersion: 3,
      acceptedAs: 'current',
      resumeExpiresAt: Date.now() + 300_000
    })
    fakes.linkOptions!.onAuthenticated()
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: requestIdAt(0),
        ok: true,
        result: {
          v: 1,
          relay,
          resumeConfirmation: {
            v: 1,
            reqId: 'confirm-1',
            currentVersion: 3,
            acceptedAs: 'current',
            renewed: true,
            resumeExpiresAt: Date.now() + 300_000
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledTimes(2))
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: requestIdAt(1),
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    await vi.waitFor(() => expect(session.getState()).toBe('connected'))

    const timings = stageTimings(entries)
    expect(timings.map((timing) => timing.name)).toEqual([
      'opening',
      'awaiting-hello',
      'handshaking',
      'confirming'
    ])
    expect(timings.every((timing) => timing.complete)).toBe(true)
    expect(timings.every((timing) => timing.ms >= 0)).toBe(true)

    // A later teardown must not append a second timing for 'confirming'.
    session.close()
    expect(stageTimings(entries)).toHaveLength(4)
  })

  it('marks a dial that never opened its socket as stuck in opening', () => {
    const entries: ConnectionLogEntry[] = []
    openSession(entries)
    fakes.linkOptions!.onError(new Error('websocket refused'))

    expect(stageTimings(entries)).toEqual([
      { kind: 'relay-dial-stage', name: 'opening', ms: expect.any(Number), complete: false }
    ])
  })
})
