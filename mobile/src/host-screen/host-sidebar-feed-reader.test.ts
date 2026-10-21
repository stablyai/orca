import { describe, expect, it, vi } from 'vitest'
import { SidebarInputsFeed } from '../../../src/main/runtime/sidebar-inputs/sidebar-inputs-feed'
import { testDomain } from '../../../src/main/runtime/sidebar-inputs/sidebar-inputs-feed.test-fixture'
import {
  SIDEBAR_INPUTS_SEMANTICS_VERSION,
  type SidebarInputsChangedEvent
} from '../../../src/shared/sidebar-list/sidebar-inputs-feed-contract'
import type { RpcResponse } from '../transport/types'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { HostSidebarFeedReader, type HostSidebarFeedRead } from './host-sidebar-feed-reader'
import { readHostSidebarFeed } from './use-host-sidebar-feed'

function ok(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

function refused(code: string, message = 'nope'): RpcResponse {
  return { id: 'r', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime' } }
}

/** The host's real feed behind a phone client that answers every read from it. */
function hostWithFeed() {
  const notices: SidebarInputsChangedEvent[] = []
  const workspaces = testDomain('workspaces', { a: { id: 'a' } })
  const feed = new SidebarInputsFeed(
    () => [workspaces.domain],
    (event) => notices.push(event)
  )
  feed.acquire('phone')
  const sendRequest = vi.fn(async (_method: string, params: unknown) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader sends only sidebarInputs.read params.
    ok(await feed.read(params as Parameters<typeof feed.read>[0]))
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader calls only sendRequest.
  const client = { sendRequest } as unknown as UnvalidatedRpcRequestPort
  const reads: HostSidebarFeedRead[] = []
  const reader = new HostSidebarFeedReader(client, (read) => reads.push(read))
  return { feed, workspaces, notices, sendRequest, reader, reads }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('HostSidebarFeedReader', () => {
  it('installs the host’s snapshot, then follows each notice to the newer revision', async () => {
    const host = hostWithFeed()
    host.reader.refresh()
    await settle()
    const first = host.reads.at(-1)!.installed!
    expect(first.domains.get('workspaces')?.get('a')).toEqual({ id: 'a' })

    host.workspaces.set('b', { id: 'b' })
    await vi.waitFor(() => expect(host.notices.at(-1)?.revision).toBeGreaterThan(first.revision))
    const notice = host.notices.at(-1)!
    host.reader.changed(notice)
    await settle()
    const next = host.reads.at(-1)!.installed!
    expect(next.revision).toBeGreaterThan(first.revision)
    expect(next.domains.get('workspaces')?.get('b')).toEqual({ id: 'b' })

    // A duplicate or late notice is already covered: no read goes out.
    const sent = host.sendRequest.mock.calls.length
    host.reader.changed(notice)
    await settle()
    expect(host.sendRequest.mock.calls.length).toBe(sent)
  })

  it.each([
    ['method_not_found', 'unknown method'],
    ['forbidden', "Method 'sidebarInputs.read' is not available to mobile clients"]
  ])('reads a host without the feed (%s) as unavailable', async (code, message) => {
    const reads: HostSidebarFeedRead[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader calls only sendRequest.
    const client = {
      sendRequest: async () => refused(code, message)
    } as unknown as UnvalidatedRpcRequestPort
    new HostSidebarFeedReader(client, (read) => reads.push(read)).refresh()
    await settle()
    expect(reads.at(-1)).toEqual({ installed: null, unavailable: true })
    expect(readHostSidebarFeed(reads.at(-1)!)).toEqual({ kind: 'reopen' })
  })

  it('keeps what it installed through a dropped read, and reads again on the next refresh', async () => {
    const host = hostWithFeed()
    host.reader.refresh()
    await settle()
    host.sendRequest.mockRejectedValueOnce(new Error('client_disconnected'))
    host.reader.refresh()
    await settle()
    expect(host.reads.at(-1)!.installed).not.toBeNull()
    host.workspaces.set('c', { id: 'c' })
    host.reader.refresh()
    await settle()
    expect(host.reads.at(-1)!.installed!.domains.get('workspaces')?.get('c')).toEqual({ id: 'c' })
  })

  it('catches up on its own when a read times out with the connection still up', async () => {
    vi.useFakeTimers()
    try {
      const host = hostWithFeed()
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(0)
      const first = host.reads.at(-1)!.installed!

      let timeOut: (error: Error) => void = () => {}
      host.sendRequest.mockImplementationOnce(
        () => new Promise<RpcResponse>((_resolve, reject) => (timeOut = reject))
      )
      host.workspaces.set('b', { id: 'b' })
      await vi.advanceTimersByTimeAsync(1_000)
      host.reader.changed(host.notices.at(-1)!)
      // A newer notice lands while that read waits; nothing else will repeat it.
      host.workspaces.set('c', { id: 'c' })
      await vi.advanceTimersByTimeAsync(1_000)
      host.reader.changed(host.notices.at(-1)!)
      timeOut(new Error('Request timed out: sidebarInputs.read'))

      await vi.advanceTimersByTimeAsync(30_000)
      const caughtUp = host.reads.at(-1)!.installed!
      expect(caughtUp.revision).toBeGreaterThan(first.revision)
      expect(caughtUp.domains.get('workspaces')?.get('c')).toEqual({ id: 'c' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying a host that keeps failing, and when the screen lets go', async () => {
    vi.useFakeTimers()
    try {
      const host = hostWithFeed()
      host.sendRequest.mockRejectedValue(new Error('Request timed out: sidebarInputs.read'))
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      const attempts = host.sendRequest.mock.calls.length
      expect(attempts).toBeGreaterThan(1)
      expect(attempts).toBeLessThan(10)

      // A fresh trigger gets a fresh budget, which disposal cancels.
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(0)
      host.reader.dispose()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(host.sendRequest.mock.calls.length).toBe(attempts + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays bounded when a batch’s first page answers but a later page keeps failing', async () => {
    vi.useFakeTimers()
    try {
      const host = hostWithFeed()
      const answer = host.sendRequest.getMockImplementation()!
      host.sendRequest.mockImplementation(async (method: string, params: unknown) => {
        const reply = await answer(method, params)
        const pageToken = new Map(Object.entries(Object(params))).get('pageToken')
        if (pageToken !== undefined) {
          throw new Error('Request timed out: sidebarInputs.read')
        }
        // Every first page says more follows, so no batch ever installs.
        return { ...reply, result: { ...Object(reply.ok ? reply.result : {}), next: 'p#1' } }
      })
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(host.reads).toEqual([])
      expect(host.sendRequest.mock.calls.length).toBeLessThan(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a reply that lands after the screen let go of its host', async () => {
    const host = hostWithFeed()
    host.reader.refresh()
    host.reader.dispose()
    await settle()
    expect(host.reads).toEqual([])
  })
})

describe('readHostSidebarFeed', () => {
  const installed = {
    generation: 'g',
    revision: 3,
    schemaVersion: 1,
    semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION,
    domains: new Map()
  }

  it('is loading until a batch installs, then ready at that revision', () => {
    expect(readHostSidebarFeed({ installed: null, unavailable: false })).toEqual({
      kind: 'loading'
    })
    expect(readHostSidebarFeed({ installed, unavailable: false })).toMatchObject({ kind: 'ready' })
  })

  it('asks to reopen when the host means other things by its inputs', () => {
    expect(
      readHostSidebarFeed({
        installed: { ...installed, semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION + 1 },
        unavailable: false
      })
    ).toEqual({ kind: 'reopen' })
  })

  it('asks a host from before desktop facts carried focus and labels to reopen', () => {
    expect(
      readHostSidebarFeed({ installed: { ...installed, semanticsVersion: 1 }, unavailable: false })
    ).toEqual({ kind: 'reopen' })
  })
})
