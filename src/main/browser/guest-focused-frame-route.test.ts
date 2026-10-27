import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  isOrcaFrameSessionTraffic,
  resolveFocusedFrameRoute,
  type GuestSessionCdpSender
} from './guest-focused-frame-route'
import { sendFrameSessionInput } from './guest-frame-input-sessions'

function fakeGuest(): WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route only uses the guest as a cache key.
  return {} as WebContents
}

type FrameModel = {
  // Document keys: '' = root, session ID = cross-site frame, 'frame:<id>' = same-site context.
  focusedFrameBySession: Record<string, string | null>
  crossSiteTargets: string[]
  sessionForTarget: Record<string, string>
  deadSessions?: Set<string>
  attachDelayMs?: number
}

function frameSender(model: FrameModel) {
  let nextObject = 0
  let nextContext = 0
  const frameByObject = new Map<string, string>()
  const frameByContext = new Map<number, string>()
  return vi.fn<GuestSessionCdpSender>(async (method, params, sessionId) => {
    const session = sessionId ?? ''
    if (model.deadSessions?.has(session)) {
      throw new Error('Session with given id not found')
    }
    switch (method) {
      case 'Runtime.evaluate': {
        const contextFrame =
          typeof params.contextId === 'number' ? frameByContext.get(params.contextId) : undefined
        const documentKey = contextFrame ? `frame:${contextFrame}` : session
        const frameId = model.focusedFrameBySession[documentKey] ?? null
        if (!frameId) {
          return { result: { type: 'object', subtype: 'null' } }
        }
        const objectId = `object-${(nextObject += 1)}`
        frameByObject.set(objectId, frameId)
        return { result: { objectId } }
      }
      case 'DOM.describeNode':
        return { node: { frameId: frameByObject.get(String(params.objectId)) } }
      case 'Page.createIsolatedWorld': {
        const contextId = (nextContext += 1)
        frameByContext.set(contextId, String(params.frameId))
        return { executionContextId: contextId }
      }
      case 'Target.getTargets':
        return {
          targetInfos: model.crossSiteTargets.map((targetId) => ({ targetId, type: 'iframe' }))
        }
      case 'Target.attachToTarget':
        if (model.attachDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, model.attachDelayMs))
        }
        return { sessionId: model.sessionForTarget[String(params.targetId)] }
      default:
        return {}
    }
  })
}

describe('resolveFocusedFrameRoute', () => {
  it('uses widget input when focus is in the main frame or a same-site frame', async () => {
    const guest = fakeGuest()
    expect(
      await resolveFocusedFrameRoute(
        guest,
        frameSender({ focusedFrameBySession: {}, crossSiteTargets: [], sessionForTarget: {} })
      )
    ).toEqual({ kind: 'widget' })
    expect(
      await resolveFocusedFrameRoute(
        guest,
        frameSender({
          focusedFrameBySession: { '': 'SAME-SITE' },
          crossSiteTargets: ['OTHER'],
          sessionForTarget: {}
        })
      )
    ).toEqual({ kind: 'widget' })
  })

  it('follows focus through a same-site frame into a cross-site frame inside it', async () => {
    const send = frameSender({
      focusedFrameBySession: { '': 'SAME-SITE', 'frame:SAME-SITE': 'CROSS' },
      crossSiteTargets: ['CROSS'],
      sessionForTarget: { CROSS: 'S1' }
    })

    expect(await resolveFocusedFrameRoute(fakeGuest(), send)).toEqual({
      kind: 'session',
      sessionId: 'S1'
    })
  })

  it('shares one attach between concurrent keys', async () => {
    const guest = fakeGuest()
    const send = frameSender({
      focusedFrameBySession: { '': 'F1' },
      crossSiteTargets: ['F1'],
      sessionForTarget: { F1: 'S1' },
      attachDelayMs: 20
    })

    const routes = await Promise.all([
      resolveFocusedFrameRoute(guest, send),
      resolveFocusedFrameRoute(guest, send)
    ])

    expect(routes).toEqual([
      { kind: 'session', sessionId: 'S1' },
      { kind: 'session', sessionId: 'S1' }
    ])
    expect(send.mock.calls.filter(([method]) => method === 'Target.attachToTarget')).toHaveLength(1)
  })

  it('keeps hiding a session whose attach answered after the caller gave up', async () => {
    vi.useFakeTimers()
    try {
      const guest = fakeGuest()
      const send = frameSender({
        focusedFrameBySession: { '': 'F1' },
        crossSiteTargets: ['F1'],
        sessionForTarget: { F1: 'LATE' },
        attachDelayMs: 2_000
      })

      const route = resolveFocusedFrameRoute(guest, send)
      await vi.advanceTimersByTimeAsync(600)
      expect(await route).toEqual({ kind: 'unknown' })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(isOrcaFrameSessionTraffic(guest, 'Runtime.consoleAPICalled', {}, 'LATE')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows focus into nested cross-site frames and reuses their sessions', async () => {
    const guest = fakeGuest()
    const send = frameSender({
      focusedFrameBySession: { '': 'OUTER', S1: 'INNER' },
      crossSiteTargets: ['OUTER', 'INNER'],
      sessionForTarget: { OUTER: 'S1', INNER: 'S2' }
    })

    expect(await resolveFocusedFrameRoute(guest, send)).toEqual({
      kind: 'session',
      sessionId: 'S2'
    })
    await resolveFocusedFrameRoute(guest, send)

    expect(send.mock.calls.filter(([method]) => method === 'Target.attachToTarget')).toHaveLength(2)
  })

  it('attaches again when a cached frame session has died', async () => {
    const guest = fakeGuest()
    const model: FrameModel = {
      focusedFrameBySession: { '': 'F1' },
      crossSiteTargets: ['F1'],
      sessionForTarget: { F1: 'OLD' }
    }
    await resolveFocusedFrameRoute(guest, frameSender(model))
    model.deadSessions = new Set(['OLD'])
    model.sessionForTarget.F1 = 'NEW'

    expect(await resolveFocusedFrameRoute(guest, frameSender(model))).toEqual({
      kind: 'session',
      sessionId: 'NEW'
    })
  })

  it('treats an unreadable main frame as main-frame focus', async () => {
    const send = vi.fn<GuestSessionCdpSender>(async () => {
      throw new Error('Execution context was destroyed')
    })

    expect(await resolveFocusedFrameRoute(fakeGuest(), send)).toEqual({ kind: 'widget' })
  })
})

describe('isOrcaFrameSessionTraffic', () => {
  it('hides only the sessions Orca attached, and forgets them when they detach', async () => {
    const guest = fakeGuest()
    await resolveFocusedFrameRoute(
      guest,
      frameSender({
        focusedFrameBySession: { '': 'F1' },
        crossSiteTargets: ['F1'],
        sessionForTarget: { F1: 'S1' }
      })
    )

    expect(isOrcaFrameSessionTraffic(guest, 'Runtime.consoleAPICalled', {}, 'S1')).toBe(true)
    expect(isOrcaFrameSessionTraffic(guest, 'Runtime.consoleAPICalled', {}, 'AGENT')).toBe(false)
    expect(isOrcaFrameSessionTraffic(guest, 'Page.loadEventFired', {}, undefined)).toBe(false)
    expect(
      isOrcaFrameSessionTraffic(guest, 'Target.detachedFromTarget', { sessionId: 'S1' }, undefined)
    ).toBe(true)
  })
})

describe('sendFrameSessionInput', () => {
  it('enables focus emulation once, retrying a failed enable before sending', async () => {
    const guest = fakeGuest()
    let failEmulation = true
    const send = vi.fn<GuestSessionCdpSender>(async (method) => {
      if (method === 'Emulation.setFocusEmulationEnabled' && failEmulation) {
        failEmulation = false
        throw new Error('Inspected target navigated or closed')
      }
      return {}
    })

    for (let i = 0; i < 3; i += 1) {
      await sendFrameSessionInput(guest, send, 'S1', 'Input.insertText', { text: 'x' })
    }

    expect(send.mock.calls.slice(0, 3).map(([method]) => method)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Emulation.setFocusEmulationEnabled',
      'Input.insertText'
    ])
    expect(
      send.mock.calls.filter(([method]) => method === 'Emulation.setFocusEmulationEnabled')
    ).toHaveLength(2)
    expect(send.mock.calls.filter(([method]) => method === 'Input.insertText')).toHaveLength(3)
  })
})
