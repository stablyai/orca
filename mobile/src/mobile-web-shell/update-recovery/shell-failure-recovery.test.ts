import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import {
  createMobileWebShellSession,
  reduceMobileWebShellSession
} from '../session/mobile-web-shell-session'
import type {
  MobileWebShellGates,
  MobileWebShellSession
} from '../session/mobile-web-shell-session-contract'

const OPEN_GATES: MobileWebShellGates = {
  statusPending: false,
  statusReadable: true,
  reachability: 'connected',
  hostCapabilities: [MOBILE_WEB_BUNDLE_CAPABILITY],
  hostStatus: { protocolVersion: 10, minCompatibleMobileVersion: 1 }
}

function readyChildSession(overrides: Partial<MobileWebShellSession> = {}): MobileWebShellSession {
  const base = createMobileWebShellSession('/h/host-1/session/wt-1')
  return {
    ...base,
    gates: OPEN_GATES,
    pagePainted: false,
    pageRemountedOnce: false,
    retriedOnce: false,
    state: {
      kind: 'ready',
      generationDirectory: '/data/generations/b1',
      sessionId: 'sess-1',
      buildId: 'a'.repeat(64),
      totalBytes: 2048,
      elapsedMs: 10,
      compat: {
        schemaVersion: 1,
        runtimeProtocolVersion: 5,
        minCompatibleRuntimeProtocolVersion: 2,
        pageVersion: 1
      }
    },
    ...overrides
  }
}

describe('shell failure recovery', () => {
  it('remounts once then auto-deletes cache and refetches on unpainted child document-load-failed', () => {
    const first = reduceMobileWebShellSession(readyChildSession(), {
      type: 'shell-failed',
      reason: 'document-load-failed'
    })
    expect(first.session.pageRemountedOnce).toBe(true)
    expect(first.effects).toEqual([{ kind: 'remount' }])

    const second = reduceMobileWebShellSession(first.session, {
      type: 'shell-failed',
      reason: 'document-load-failed'
    })
    expect(second.session.retriedOnce).toBe(true)
    expect(second.session.manifestFirst).toBe(true)
    expect(second.session.state.kind).toBe('checking')
    expect(second.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
  })

  it('auto-refetches immediately without remounting stale cache when host already offered a newer build', () => {
    const step = reduceMobileWebShellSession(
      readyChildSession({ requestedBuildId: 'b'.repeat(64) }),
      { type: 'shell-failed', reason: 'document-load-failed' }
    )
    expect(step.session.retriedOnce).toBe(true)
    expect(step.session.manifestFirst).toBe(true)
    expect(step.session.state.kind).toBe('checking')
    expect(step.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
  })

  it('surfaces document-load-failed once automatic refetch was already exhausted', () => {
    const step = reduceMobileWebShellSession(
      readyChildSession({ pageRemountedOnce: true, retriedOnce: true }),
      { type: 'shell-failed', reason: 'document-load-failed' }
    )
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'document-load-failed',
      retriedOnce: true
    })
    expect(step.effects).toEqual([])
  })
})
