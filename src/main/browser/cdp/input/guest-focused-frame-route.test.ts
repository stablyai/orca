import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { isOrcaFrameSessionTraffic, type GuestSessionCdpSender } from './guest-frame-input-sessions'
import { resolveFocusedFrameRoute } from './guest-focused-frame-route'

function fakeGuest(): WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route only uses the guest as a cache key.
  return {} as WebContents
}

type FrameModel = {
  // Document keys: '' = root, session ID = cross-site frame, 'frame:<id>' = same-site context.
  focusedFrameBySession: Record<string, string | null>
  focusedElementBySession?: Record<string, boolean>
  rootProbeFails?: boolean
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
        if (model.rootProbeFails && session === '' && params.contextId === undefined) {
          throw new Error('Execution context was destroyed')
        }
        const contextFrame =
          typeof params.contextId === 'number' ? frameByContext.get(params.contextId) : undefined
        const documentKey = contextFrame ? `frame:${contextFrame}` : session
        const frameId = model.focusedFrameBySession[documentKey] ?? null
        if (!frameId) {
          return {
            result: {
              type: 'boolean',
              value: model.focusedElementBySession?.[documentKey] ?? false
            }
          }
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
})
