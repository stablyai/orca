import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeClientNotReadyError } from './bridge-client-errors'
import {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION
} from './bridge-envelope'
import { BRIDGE_HAPTICS_GRANT, BRIDGE_HAPTICS_NOTIFY } from './bridge-haptics-notify'
import { BRIDGE_LIVENESS_PROBE_NOTIFY } from './bridge-liveness-probe-notify'
import { GRANTS, INIT, createPageClient as createPage } from './bridge-page-client-test-harness'

const resources = new Set<ReturnType<typeof createPage>>()
function createPageClient(...args: Parameters<typeof createPage>): ReturnType<typeof createPage> {
  const resource = createPage(...args)
  resources.add(resource)
  return resource
}
function closeResources(): void {
  for (const resource of resources) {
    resource.client.close()
  }
  resources.clear()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  closeResources()
  vi.useRealTimers()
})

describe('bridge client page faults', () => {
  function startGranted(page: ReturnType<typeof createPageClient>): void {
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_FAULT_GRANT] } })
  }

  it('posts the captured error once the shell has granted fault reporting', () => {
    const page = createPageClient()
    startGranted(page)
    expect(page.client.notifyPageFault(new Error('the route threw'))).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_FAULT_GRANT,
      error: { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
    })
  })

  it('stays quiet against a shell that granted nothing, because the frame would be refused whole', () => {
    const page = createPageClient()
    page.start()
    expect(page.client.notifyPageFault(new Error('the route threw'))).toBe(false)
    expect(page.sent).toHaveLength(1)
  })

  it('answers false before a session and after close rather than throwing at a boundary', () => {
    const early = createPageClient()
    expect(early.client.notifyPageFault(new Error('too soon'))).toBe(false)
    const page = createPageClient()
    startGranted(page)
    page.client.close()
    expect(page.client.notifyPageFault(new Error('too late'))).toBe(false)
    expect(page.frames().at(-1)).toEqual({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
  })

  it('answers false for a port that refused the frame, and reports it once', () => {
    let fails = false
    const page = createPageClient({
      send: () => {
        if (fails) {
          throw new Error('the channel is gone')
        }
      }
    })
    startGranted(page)
    expect(page.diagnostics).toEqual([])
    fails = true
    expect(page.client.notifyPageFault(new Error('the route threw'))).toBe(false)
    expect(page.diagnostics).toEqual([{ kind: 'send-failed', error: expect.any(Error) }])
  })
})

// Before init, gated notifies return false before requiring a session; route-handoff tap handlers rely on that fallback and do not catch throws.
describe('the notify guard before init', () => {
  it('answers false for the grant-gated notifies and posts nothing', () => {
    const page = createPageClient()
    const beforeNotifies = page.sent.length
    expect(page.client.notifyNavigate('/h/host-1')).toBe(false)
    expect(page.client.notifyNavigateBack()).toBe(false)
    expect(page.client.notifyExternalLink('https://example.com')).toBe(false)
    expect(page.client.notifyStorageWrite('orca:last-visited-worktree', 'value')).toBe(false)
    expect(page.sent).toHaveLength(beforeNotifies)
  })

  it('still throws for the ungated ones, which is the mount-order bug the guard is for', () => {
    const page = createPageClient()
    expect(() => page.client.notifyForeground()).toThrow(BridgeClientNotReadyError)
    expect(() =>
      page.client.updateTerminalSubscriptionViewport('terminal-1', { cols: 80, rows: 24 })
    ).toThrow(BridgeClientNotReadyError)
  })

  it('posts the gated ones once the shell has granted them', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate', 'storage'] } })
    expect(page.client.notifyNavigate('/h/host-1')).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: 'navigate',
      href: '/h/host-1'
    })
    expect(page.client.notifyStorageWrite('orca:last-visited-worktree', 'wt-1')).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: 'storage',
      key: 'orca:last-visited-worktree',
      value: 'wt-1'
    })
  })
})

// Older shells may grant navigate but reject the newer Back notify; false retains the caller’s router fallback, which has no native history to pop on page.
describe('navigate-back', () => {
  it('posts under the navigate grant, with no target of its own', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate'] } })
    expect(page.client.notifyNavigateBack()).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_NAVIGATE_BACK_NOTIFY
    })
  })

  it('stays quiet against a shell that granted no navigate', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['storage'] } })
    const beforeNotify = page.sent.length
    expect(page.client.notifyNavigateBack()).toBe(false)
    expect(page.sent).toHaveLength(beforeNotify)
  })

  it('answers false after close rather than throwing into a teardown', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate'] } })
    page.client.close()
    expect(page.client.notifyNavigateBack()).toBe(false)
  })
})

// Reject invalid URL calls before posting; notify has no reply and true must not claim a tap succeeded when the shell will drop its frame.
describe('externalLink', () => {
  function granted(): ReturnType<typeof createPageClient> {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_EXTERNAL_LINK_GRANT] } })
    return page
  }

  it('posts an allowed URL under its own grant', () => {
    const page = granted()
    expect(page.client.notifyExternalLink('https://github.com/stablyai/orca')).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_EXTERNAL_LINK_GRANT,
      url: 'https://github.com/stablyai/orca'
    })
  })

  it('posts the URL the parser read, not the string the caller handed it', () => {
    const page = granted()
    expect(page.client.notifyExternalLink('  https://example.com/a\r\n  ')).toBe(true)
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: BRIDGE_EXTERNAL_LINK_GRANT,
      url: 'https://example.com/a'
    })
  })

  it('answers false for a scheme the grant does not cover, and posts nothing', () => {
    const page = granted()
    const beforeNotify = page.sent.length
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', '/h/host-a/tasks']) {
      expect(page.client.notifyExternalLink(url), url).toBe(false)
    }
    expect(page.sent).toHaveLength(beforeNotify)
  })

  it('stays quiet against a shell that granted no externalLink', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...GRANTS, native: ['navigate', 'storage'] } })
    const beforeNotify = page.sent.length
    expect(page.client.notifyExternalLink('https://example.com')).toBe(false)
    expect(page.sent).toHaveLength(beforeNotify)
  })

  it('answers false after close rather than throwing into a teardown', () => {
    const page = granted()
    page.client.close()
    expect(page.client.notifyExternalLink('https://example.com')).toBe(false)
  })
})

// Check haptic grants before posting into the closed notify union. Return refusal silently to avoid a warning per scrolling-row tap.
describe('bridge client haptics', () => {
  const granted = (page: ReturnType<typeof createPageClient>): void => {
    page.deliver({ ...INIT, grants: { ...GRANTS, native: [BRIDGE_HAPTICS_GRANT] } })
  }

  it('posts one frame per kind, carrying the kind it was asked for', () => {
    const page = createPageClient()
    granted(page)
    const kinds = ['mediumImpact', 'selection', 'success', 'error', 'edgeBump'] as const
    for (const kind of kinds) {
      expect(page.client.notifyHaptics(kind), kind).toBe(true)
    }
    expect(page.frames().slice(1)).toEqual(
      kinds.map((kind) => ({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: BRIDGE_HAPTICS_NOTIFY,
        kind
      }))
    )
  })

  it('stays quiet against a shell that granted nothing, because the frame would be refused whole', () => {
    const page = createPageClient()
    page.start()
    expect(page.client.notifyHaptics('selection')).toBe(false)
    expect(page.sent).toHaveLength(1)
  })

  it('answers false before a session and after close rather than throwing inside a tap handler', () => {
    const early = createPageClient()
    expect(early.client.notifyHaptics('selection')).toBe(false)
    const page = createPageClient()
    granted(page)
    page.client.close()
    expect(page.client.notifyHaptics('selection')).toBe(false)
    expect(page.frames().at(-1)).toEqual({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
  })
})

// No grant gates it: an older shell refuses the frame with one diagnostic and keeps its idle watchdog.
describe('bridge client liveness probe', () => {
  it('posts a probe frame once the session is up', () => {
    const page = createPageClient()
    page.start()
    page.client.probeLivenessNow?.()
    expect(page.frames().slice(1)).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_LIVENESS_PROBE_NOTIFY }
    ])
  })
})
