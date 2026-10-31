// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import {
  attach,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { readCodexMcpElicitation } from './codex-mcp-elicitation'
import { projectStructuredPermission } from '../../../mobile/src/session/mobile-structured-agent-prompts'
import { createBridgePortPair } from '../../../mobile/src/mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient } from '../../../mobile/src/mobile-web-shell/bridge-host-test-fakes'
import {
  createPageClient,
  INIT,
  GRANTS
} from '../../../mobile/src/mobile-web-shell/bridge/bridge-page-client-test-harness'
import {
  BRIDGE_EXTERNAL_LINK_FULL_URL,
  BRIDGE_EXTERNAL_LINK_GRANT
} from '../../../mobile/src/mobile-web-shell/bridge/bridge-frame-fields'
import {
  canOpenExternalLink,
  openExternalLink,
  publishExternalLinkOpener,
  useExternalLinkAvailable
} from '../../../mobile/src/platform/external-link.web'
import { readBridgeClientMessage } from '../../../mobile/src/mobile-web-shell/bridge/bridge-envelope'

let adapter: ReturnType<typeof adapterFor> | undefined
afterEach(async () => {
  cleanup()
  await adapter?.closeAll()
  vi.restoreAllMocks()
})

it('hands complete actual elicitation addresses through projection, page helper, notification parser/grant and recorded device opener once', async () => {
  const state = hostTestState()
  await attach()
  const codex = fakeCodex()
  adapter = adapterFor(codex, { resumeThreadId: THREAD })
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor(SESSION),
    fence: state.store.getRecord(SESSION)!.lease.runtimeFence,
    spawnToken: 'spawn-a',
    events: state.acquire.mock.calls.at(-1)![0].events
  })
  const pair = createBridgePortPair({ rpc: createFakeRpcClient() })
  await pair.flush()
  publishExternalLinkOpener((url) => pair.client.notifyExternalLink(url), {
    read: pair.client.getExternalLinkSupport,
    subscribe: pair.client.onExternalLinkSupport
  })
  const urls = [2048, 2049, 8192].map((length) => `https://example.com/${'a'.repeat(length - 20)}`)
  urls.push(
    `https://example.com/${'界'.repeat(8192 - 20)}`,
    'HTTPS://example.com/a',
    'https://example.com/a%20b',
    'https://example.com/"\\\u0001\ud800'
  )
  try {
    for (const [id, url] of urls.entries()) {
      const params = {
        threadId: THREAD,
        turnId: 'turn-1',
        mode: 'url',
        message: 'Connect',
        url,
        elicitationId: `url-${id}`
      }
      expect(readCodexMcpElicitation(params), url).toMatchObject({ kind: 'url', url })
      codex.connections[0].handlers.onServerRequest?.({
        id,
        method: 'mcpServer/elicitation/request',
        params
      })
      await state.host.flushStreamedEvents(SESSION)
      const journal = state.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const item = journal.snapshot().items.findLast((row) => row.body.kind === 'approval')!
      if (item.body.kind !== 'approval') {
        throw new Error('Missing URL approval')
      }
      const permission = projectStructuredPermission({ ...item, body: item.body })!
      expect(permission.url).toBe(url)
      expect(permission.options.map((option) => option.label)).toEqual([
        'Continue',
        'Decline',
        'Cancel'
      ])
      expect(canOpenExternalLink(permission.url!)).toBe(true)
      openExternalLink(permission.url!)
      await pair.flush()
      expect(pair.externalLinks).toEqual(urls.slice(0, id + 1))
      expect(codex.connections[0].replies).toEqual([])
    }
    const aliases = ['  https://example.com/a\r\n  ', 'ht\ntps://example.com', 'https:example.com']
    for (const alias of aliases) {
      expect(canOpenExternalLink(alias)).toBe(true)
      openExternalLink(alias)
      await pair.flush()
    }
    const handedOff = [...urls, ...aliases]
    expect(pair.externalLinks).toEqual(handedOff)
    const sent = pair.toShell.length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const url of ['javascript:alert(1)', 'file:///a', '/relative', 'data:text/plain,hello']) {
      expect(canOpenExternalLink(url)).toBe(false)
      openExternalLink(url)
      // Actual receiver still refuses a malicious page bypassing its helper/writer.
      pair.host.receive(JSON.stringify({ v: 1, type: 'notify', name: 'externalLink', url }))
    }
    expect(pair.toShell).toHaveLength(sent)
    expect(pair.externalLinks).toEqual(handedOff)
    expect(warn).toHaveBeenCalledTimes(4)
    const frames = pair.toShell.filter((raw) => raw.includes('"name":"externalLink"'))
    expect(frames).toHaveLength(handedOff.length)
    for (const frame of frames) {
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(655360)
      expect(readBridgeClientMessage(frame).ok).toBe(true)
    }
    expect(new URL(urls[3]).href.length).toBeGreaterThan(8192)
  } finally {
    pair.client.close()
    pair.host.dispose()
  }
})

it('selects actual INIT support including equal/changed same-session repair, legacy normalization, replacement and close', () => {
  const page = createPageClient()
  const changed = vi.fn()
  page.client.onExternalLinkSupport(changed)
  publishExternalLinkOpener((url) => page.client.notifyExternalLink(url), {
    read: page.client.getExternalLinkSupport,
    subscribe: page.client.onExternalLinkSupport
  })
  const long = `https://example.com/${'x'.repeat(8192 - 20)}`
  expect(canOpenExternalLink(long)).toBe(false)
  const legacy = { ...INIT, grants: { ...GRANTS, native: [BRIDGE_EXTERNAL_LINK_GRANT] } }
  page.deliver(legacy)
  const support = page.client.getExternalLinkSupport()
  page.deliver({ ...legacy, keyboardInset: 40 })
  expect(page.client.getExternalLinkSupport()).toBe(support)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(canOpenExternalLink(long)).toBe(false)
  openExternalLink('  https://example.com/a\r\n ')
  expect(page.frames().at(-1)).toMatchObject({ name: 'externalLink', url: 'https://example.com/a' })
  const complete = {
    ...legacy,
    grants: { ...GRANTS, native: [BRIDGE_EXTERNAL_LINK_GRANT, BRIDGE_EXTERNAL_LINK_FULL_URL] }
  }
  page.deliver(complete)
  expect(changed).toHaveBeenCalledTimes(2)
  expect(canOpenExternalLink(long)).toBe(true)
  openExternalLink(long)
  expect(page.frames().at(-1)).toMatchObject({ name: 'externalLink', url: long })
  const generic = `https://example.com/${'x'.repeat(700000)}`
  page.deliver({ ...complete, inboundMessageBytes: 4194304 })
  expect(canOpenExternalLink(generic)).toBe(true)
  page.deliver({ ...complete, inboundMessageBytes: 655360 })
  expect(canOpenExternalLink(generic)).toBe(false)
  page.deliver({ ...complete, inboundMessageBytes: 100 })
  expect(canOpenExternalLink(long)).toBe(true)
  page.deliver({ ...complete, grants: { ...GRANTS, native: [BRIDGE_EXTERNAL_LINK_FULL_URL] } })
  expect(canOpenExternalLink('https://example.com')).toBe(false)
  page.deliver({ ...complete, sessionId: 'replacement' })
  expect(canOpenExternalLink(long)).toBe(true)
  page.client.close()
  expect(canOpenExternalLink(long)).toBe(false)
  expect(page.client.notifyExternalLink(long)).toBe(false)
})

it('preserves old-page normalized frames on an implementing receiver and route authorization independently of the token', async () => {
  const pair = createBridgePortPair({
    rpc: createFakeRpcClient(),
    rewriteToPage: (raw) => {
      const frame = JSON.parse(raw)
      if (frame.type === 'init') {
        frame.grants.native = frame.grants.native.filter(
          (grant: string) => grant !== BRIDGE_EXTERNAL_LINK_FULL_URL
        )
      }
      return JSON.stringify(frame)
    }
  })
  const ungranted = createBridgePortPair({ rpc: createFakeRpcClient(), routeGrants: [] })
  try {
    await pair.flush()
    await ungranted.flush()
    expect(pair.client.notifyExternalLink('  https://example.com/a\r\n ')).toBe(true)
    expect(pair.client.notifyExternalLink(`https://example.com/${'x'.repeat(2049)}`)).toBe(false)
    await pair.flush()
    expect(pair.externalLinks).toEqual(['https://example.com/a'])
    expect(ungranted.client.getExternalLinkSupport()).toMatchObject({
      complete: true,
      granted: false
    })
    ungranted.host.receive(
      JSON.stringify({ v: 1, type: 'notify', name: 'externalLink', url: 'https://example.com' })
    )
    expect(ungranted.externalLinks).toEqual([])
  } finally {
    pair.client.close()
    pair.host.dispose()
    ungranted.client.close()
    ungranted.host.dispose()
  }
})

it('selects URL availability from the real shell support subscription without irrelevant renders', async () => {
  const page = createPageClient()
  publishExternalLinkOpener((url) => page.client.notifyExternalLink(url), {
    read: page.client.getExternalLinkSupport,
    subscribe: page.client.onExternalLinkSupport
  })
  const long = `https://example.com/${'a'.repeat(8192 - 20)}`
  const shortRenders = vi.fn(),
    longRenders = vi.fn()
  function ShortAvailability() {
    const available = useExternalLinkAvailable('https://example.com/a')
    shortRenders()
    return createElement('button', { disabled: !available }, 'https://example.com/a')
  }
  function LongAvailability() {
    const available = useExternalLinkAvailable(long)
    longRenders()
    return createElement('button', { disabled: !available }, long)
  }
  const view = render(
    createElement('div', {}, createElement(ShortAvailability), createElement(LongAvailability))
  )
  const legacy = { ...INIT, grants: { ...GRANTS, native: [BRIDGE_EXTERNAL_LINK_GRANT] } }
  await act(async () => {
    page.deliver(legacy)
  })
  const initial = [shortRenders.mock.calls.length, longRenders.mock.calls.length]
  await act(async () => {
    page.deliver({ ...legacy, keyboardInset: 100 })
  })
  expect([shortRenders.mock.calls.length, longRenders.mock.calls.length]).toEqual(initial)
  await act(async () => {
    page.deliver({
      ...legacy,
      grants: { ...GRANTS, native: [BRIDGE_EXTERNAL_LINK_GRANT, BRIDGE_EXTERNAL_LINK_FULL_URL] }
    })
  })
  expect(shortRenders).toHaveBeenCalledTimes(initial[0])
  expect(longRenders.mock.calls.length).toBeGreaterThan(initial[1])
  const buttons = view.container.querySelectorAll('button')
  expect(buttons[0].disabled).toBe(false)
  expect(buttons[1].disabled).toBe(false)
  await act(async () => {
    page.client.close()
  })
  expect(buttons[0].disabled).toBe(true)
  expect(buttons[1].disabled).toBe(true)
})
