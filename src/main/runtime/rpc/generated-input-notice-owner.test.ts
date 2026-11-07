import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgentPromptSubmissionRuntime } from '../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { GENERATED_INPUT_METHODS } from './methods/terminal/generated-input'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { GeneratedInputNoticesPage } from '../../../shared/generated-agent-input-notice'
import { GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY } from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { GeneratedInputIngress } from '../generated-agent-input-notices-ingress'
import { forwardGeneratedInputNotices } from '../generated-agent-input-notice-forwarder'

const { ROWS } = vi.hoisted(() => ({
  ROWS: [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ]
}))
vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: vi.fn().mockResolvedValue(ROWS)
}))
vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: vi.fn().mockResolvedValue(ROWS)
}))

const DIALOG =
  '\x1b[2J\x1b[HBypass Permissions\r\n❯ 1. No, exit\r\n  2. Yes, I accept\r\nEnter to confirm · Esc to cancel'
const TEXT = 'exact\r\n  "prompt" \\ 😀 end  '
const ENV = 'env-host'
const WINDOW = 'window-a'

const all = eraseRpcMethods(GENERATED_INPUT_METHODS)
function method(name: string): RpcMethod {
  const found = all.find((entry) => entry.name === name)
  if (!found || 'stream' in found) {
    throw new Error(`missing ${name}`)
  }
  return found
}
const send = method('terminal.sendGeneratedInput')
const page = method('terminal.generatedInputNotices.page')
const dismiss = method('terminal.dismissGeneratedInputNotice')
const register = method('terminal.generatedInputNotices.register')
const subscribe = all.find((entry) => entry.name === 'terminal.generatedInputNotices.subscribe')!

function as(runtime: OrcaRuntimeService, fields: Record<string, unknown>): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the runtime and the caller identities given here.
  return {
    runtime,
    clientCapabilities: [GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY],
    ...fields
  } as unknown as RpcContext
}

// Main's own connection to a host, as this desktop's pairing, and a phone paired to that host.
const fromDesktop = (runtime: OrcaRuntimeService) =>
  as(runtime, { connectionId: 'desktop-main', pairedDeviceId: 'desktop' })
const fromPhone = (runtime: OrcaRuntimeService) =>
  as(runtime, { connectionId: 'phone', pairedDeviceId: 'phone' })

type HeldCall = { name: string; release: (reached: boolean) => void }

/** This desktop (its window's own runtime, main's ingress and forwarder) and the paired host
 *  that runs the window's request, joined by the host calls main already makes. A held link
 *  answers each call only when the test releases it. */
async function desktopAndHost() {
  const host = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const local = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an empty array holds no element of another type.
  const link = { to: host.runtime, online: true, hold: false, held: [] as HeldCall[], sent: 0 }
  let statusChanged = (): void => {}
  forwardGeneratedInputNotices(local.runtime.generatedInputNotices, {
    call: async (_host, name, params) => {
      link.sent += 1
      const reached = link.hold
        ? await new Promise<boolean>((release) => link.held.push({ name, release }))
        : link.online
      if (!reached) {
        throw new Error('socket closed')
      }
      const target = link.to
      const result = await method(name).handler(
        method(name).params!.parse(params),
        fromDesktop(target)
      )
      return { id: name, ok: true, result, _meta: { runtimeId: target.getRuntimeId() } }
    },
    onStatusChanged: (listener) => {
      statusChanged = listener
      return () => {}
    },
    onEnvironmentRetired: () => () => {},
    isManuallyDisconnected: () => false
  })
  const window = (connection: string) =>
    as(local.runtime, { connectionId: connection, noticeOrigin: 'desktop-window:1' })
  const view = async (context: RpcContext, window?: string) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page method answers a GeneratedInputNoticesPage.
    const answer = (await page.handler(
      window ? { window } : {},
      context
    )) as GeneratedInputNoticesPage
    return {
      ids: answer.frames.map(({ id }) => id),
      certainty: answer.frames.map(({ certainty }) => certainty),
      withheld: answer.withheld ?? []
    }
  }
  return {
    host,
    local,
    link,
    owned: local.runtime.generatedInputNotices,
    reconnect: () => statusChanged(),
    window,
    released: (reached: boolean) => link.held.shift()!.release(reached),
    heldCalls: () => link.held.map(({ name }) => name),
    onHost: (runtime = host.runtime) => view(fromDesktop(runtime), WINDOW),
    onPhone: (runtime = host.runtime) => view(fromPhone(runtime)),
    onLocal: (connection: string) => view(window(connection)),
    // A renderer (re)loading subscribes to its own runtime's notices.
    reload: (connection: string) => {
      if ('stream' in subscribe) {
        void subscribe.handler(null, window(connection), () => {})
      }
    }
  }
}

type Desktop = Awaited<ReturnType<typeof desktopAndHost>>

// Qualified by the runtime whose support the window verified: only that runtime may run it.
const sendParams = (d: Desktop, id: string) => ({
  terminal: { handle: d.host.handle, expectedRuntimeId: d.host.runtime.getRuntimeId() },
  text: TEXT,
  submit: true,
  agent: 'claude',
  intent: 'running' as const,
  timeoutMs: 200,
  retainNotice: true,
  operationId: id,
  window: WINDOW
})

/** The window sends to the host: its text is held where the request leaves this desktop, whose
 *  qualified target names the runtime that runs it, and the window's own hold names its key. */
function sendFromWindow(d: Desktop, id: string, screen = DIALOG) {
  const params = sendParams(d, id)
  const observe = new GeneratedInputIngress(d.owned).accept(
    'terminal.sendGeneratedInput',
    params,
    { origin: 'desktop-window:1', connection: 'renderer-1' },
    { environmentId: ENV, pairingRevision: 1 }
  )!
  void register.handler(
    {
      id,
      text: TEXT,
      agent: 'claude',
      certainty: 'not-sent',
      pending: true,
      owner: { environmentId: ENV, window: WINDOW }
    },
    d.window('renderer-1')
  )
  d.host.runtime.onPtyData('pty-prompt', screen, 0)
  observe.dispatched()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the send method handler is async.
  const sending = send.handler(params, fromDesktop(d.host.runtime)) as Promise<unknown>
  return {
    observe,
    // The host's answer, passed back through main as the transport delivers it.
    answered: async () =>
      observe.answered({
        id: 'send',
        ok: true,
        result: await sending,
        _meta: { runtimeId: d.host.runtime.getRuntimeId() }
      })
  }
}

// L3/R6-3: a reload while a paired host still runs the request, then that host fails it: one
// operation. Once the window shows the host's copy its own gives way, so a phone's Dismiss of the
// host copy leaves nothing behind, before or after a reload.
it('keeps one operation across a reload and a later host failure, ended everywhere by one Dismiss', async () => {
  const d = await desktopAndHost()
  const { answered } = sendFromWindow(d, 'op-reload')
  d.reload('renderer-2')
  expect((await d.onLocal('renderer-2')).ids).toEqual(['op-reload'])
  await vi.waitFor(async () => expect((await d.onHost()).ids).toEqual(['op-reload']))
  expect((await d.onPhone()).ids).toEqual([])

  await answered()
  expect((await d.onPhone()).ids).toEqual(['op-reload'])
  const seen = { environmentId: ENV, window: WINDOW, pairingRevision: 1 }
  const settleSeen = (runtimeId: string) =>
    register.handler(
      {
        id: 'op-reload',
        settle: true,
        text: '',
        agent: null,
        certainty: 'not-sent',
        observed: { ...seen, runtimeId }
      },
      d.window('renderer-2')
    )
  // A copy from another runtime under the same environment is not this operation's host.
  await settleSeen('another-runtime')
  expect((await d.onLocal('renderer-2')).ids).toEqual(['op-reload'])
  await settleSeen(d.host.runtime.getRuntimeId())
  expect((await d.onLocal('renderer-2')).ids).toEqual([])

  await dismiss.handler({ id: 'op-reload' }, fromPhone(d.host.runtime))
  expect((await d.onHost()).ids).toEqual([])
  d.reload('renderer-3')
  expect((await d.onLocal('renderer-3')).ids).toEqual([])
  expect(d.host.writes).toEqual([])
})

// Ruling r37217-q3-growth #2: a copy's late acknowledgment never consumes the discard that
// replaced it; the discard still reaches the host and its later failure stays discarded.
it('keeps a Dismiss owed when the copy it replaced is acknowledged afterwards', async () => {
  const d = await desktopAndHost()
  d.link.hold = true
  const { answered } = sendFromWindow(d, 'op-race')
  d.reload('renderer-2')
  await vi.waitFor(() => expect(d.heldCalls()).toEqual(['terminal.generatedInputNotices.register']))
  await dismiss.handler({ id: 'op-race' }, d.window('renderer-2'))
  expect((await d.onLocal('renderer-2')).withheld).toEqual(['op-race'])

  d.released(true)
  await vi.waitFor(() => expect(d.heldCalls()).toEqual(['terminal.dismissGeneratedInputNotice']))
  expect(d.owned.commands.of('op-race')?.kind).toBe('discard')
  d.released(true)
  await vi.waitFor(async () => expect((await d.onLocal('renderer-2')).withheld).toEqual([]))
  expect((await d.onHost()).ids).toEqual([])
  await answered()
  expect((await d.onPhone()).ids).toEqual([])
  expect(d.host.writes).toEqual([])
})

// The original send's late "kept" answer is no acknowledgment of a Dismiss made meanwhile, and a
// connectivity wake that arrives while the discard's call is failing is not lost.
it('retries an owed Dismiss on a wake that arrived during its failing call, past a late send answer', async () => {
  const d = await desktopAndHost()
  const { answered } = sendFromWindow(d, 'op-late')
  d.reload('renderer-2')
  await vi.waitFor(async () => expect((await d.onHost()).ids).toEqual(['op-late']))
  d.link.hold = true
  await dismiss.handler({ id: 'op-late' }, d.window('renderer-2'))
  await vi.waitFor(() => expect(d.heldCalls()).toEqual(['terminal.dismissGeneratedInputNotice']))
  d.reconnect()
  d.released(false)

  await answered()
  expect(d.owned.commands.of('op-late')?.kind).toBe('discard')
  // Honest while the host has not applied it: its own failure is still there for the phone.
  expect((await d.onPhone()).ids).toEqual(['op-late'])

  await vi.waitFor(() => expect(d.heldCalls()).toEqual(['terminal.dismissGeneratedInputNotice']))
  d.released(true)
  await vi.waitFor(async () => expect((await d.onPhone()).ids).toEqual([]))
  expect((await d.onHost()).ids).toEqual([])
  expect(
    await register.handler(
      { id: 'op-late', window: WINDOW, text: TEXT, agent: 'claude', certainty: 'unconfirmed' },
      fromDesktop(d.host.runtime)
    )
  ).toEqual({ retained: false, discarded: true })
  expect(d.host.writes).toEqual([])
})

// A host restarted under the same environment is another runtime: nothing meant for the earlier
// one applies there or leaves a tombstone, and this window keeps its own honest copy.
it('never applies recovery work to a replacement runtime, keeping the local copy', async () => {
  const d = await desktopAndHost()
  const replacement = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const { answered } = sendFromWindow(d, 'op-restarted')
  d.link.to = replacement.runtime
  d.reload('renderer-2')
  await vi.waitFor(() => expect(d.link.sent).toBe(1))
  await vi.waitFor(() => expect(d.owned.commands.of('op-restarted')).toBeUndefined())
  expect((await d.onHost(replacement.runtime)).ids).toEqual([])
  expect((await d.onLocal('renderer-2')).ids).toEqual(['op-restarted'])

  await dismiss.handler({ id: 'op-restarted' }, d.window('renderer-2'))
  expect(d.owned.commands.of('op-restarted')).toBeUndefined()
  d.reconnect()
  expect(d.link.sent).toBe(1)
  expect(
    await dismiss.handler(
      { id: 'op-restarted', window: WINDOW, authorityRuntimeId: d.host.runtime.getRuntimeId() },
      fromDesktop(replacement.runtime)
    )
  ).toEqual({ dismissed: false, stale: true })
  expect(
    await register.handler(
      { id: 'op-restarted', window: WINDOW, text: TEXT, agent: 'claude', certainty: 'unconfirmed' },
      fromDesktop(replacement.runtime)
    )
  ).toEqual({ retained: true })
  await answered()
  expect(replacement.writes).toEqual([])
})

// A2: accepted text reads as not sent until the transport sends it, even when preparation never
// finishes or fails, and the host's own answer settles the copy with no renderer left.
it('reads not sent until dispatch, possibly sent after, and settles from the host answer alone', async () => {
  const d = await desktopAndHost()
  const changes: string[] = []
  d.owned.subscribe((change) =>
    changes.push(change.kind === 'added' ? change.notice.certainty : 'dismissed')
  )
  const accept = (id: string) =>
    new GeneratedInputIngress(d.owned).accept(
      'terminal.sendGeneratedInput',
      sendParams(d, id),
      { origin: 'desktop-window:1', connection: 'renderer-1' },
      { environmentId: ENV, pairingRevision: 1 }
    )!
  const preparing = accept('op-preparing')
  d.reload('renderer-2')
  expect((await d.onLocal('renderer-2')).certainty).toEqual(['not-sent'])
  preparing.dispatched()
  expect((await d.onLocal('renderer-2')).certainty).toEqual(['unconfirmed'])
  expect(changes).toEqual(['not-sent', 'unconfirmed'])

  // Preparation failed before sending: the window's later inference cannot call it sent.
  accept('op-unsent').answered(null)
  await register.handler(
    { id: 'op-unsent', text: TEXT, agent: 'claude', certainty: 'unconfirmed' },
    d.window('renderer-2')
  )
  expect((await d.onLocal('renderer-2')).certainty).toEqual(['unconfirmed', 'not-sent'])

  const delivered = accept('op-delivered')
  delivered.dispatched()
  delivered.answered({
    id: 'send',
    ok: true,
    result: { delivery: { outcome: 'delivered' } },
    _meta: { runtimeId: 'h' }
  })
  d.reload('renderer-3')
  expect((await d.onLocal('renderer-3')).ids).toEqual(['op-preparing', 'op-unsent'])
})

const READY = '\x1b[2J\x1b[H\x1b[?2004h\x1b[?2031h❯ '

// XR1 receiver contract: a request qualified for one runtime is refused by any other before any
// part is staged, any target resolved or anything written, and a receiver predating the form
// rejects it at its schema; the window's record then knows it was not sent.
it('refuses a request qualified for another runtime before anything of it is staged', async () => {
  const d = await desktopAndHost()
  const replacement = await createAgentPromptSubmissionRuntime(() => {}, 'claude')
  const params = sendParams(d, 'op-fenced')
  const replaced = fromDesktop(replacement.runtime)
  const first = { ...params, part: { id: 'upload', index: 0, final: false } }
  expect(await send.handler(send.params!.parse(first), replaced)).toEqual({
    refused: 'runtime-changed'
  })
  expect(await send.handler(send.params!.parse(params), replaced)).toEqual({
    refused: 'runtime-changed'
  })
  expect(replacement.runtime.generatedInputNotices.sizes.notices).toBe(0)
  expect(replacement.writes).toEqual([])
  // The prior receiver's string-only address: the qualified form never reaches its handler.
  expect(z.object({ terminal: z.string().optional() }).safeParse(params).success).toBe(false)

  const observe = new GeneratedInputIngress(d.owned).accept(
    'terminal.sendGeneratedInput',
    params,
    { origin: 'desktop-window:1', connection: 'renderer-1' },
    { environmentId: ENV, pairingRevision: 1 }
  )!
  observe.dispatched()
  observe.answered({
    id: 'send',
    ok: true,
    result: { refused: 'runtime-changed' },
    _meta: { runtimeId: 'h2' }
  })
  d.reload('renderer-2')
  expect((await d.onLocal('renderer-2')).certainty).toEqual(['not-sent'])
})

// CR3: the host acknowledged holding this window's copy; the original send's later "delivered"
// answer cannot make the window forget that, so a Dismiss still discards the host's copy.
it('keeps the host-held proof past a late delivered answer, so Dismiss reaches the host', async () => {
  const d = await desktopAndHost()
  const params = sendParams(d, 'op-held')
  const observe = new GeneratedInputIngress(d.owned).accept(
    'terminal.sendGeneratedInput',
    params,
    { origin: 'desktop-window:1', connection: 'renderer-1' },
    { environmentId: ENV, pairingRevision: 1 }
  )!
  void register.handler(
    {
      id: 'op-held',
      text: TEXT,
      agent: 'claude',
      certainty: 'not-sent',
      pending: true,
      owner: { environmentId: ENV, window: WINDOW }
    },
    d.window('renderer-1')
  )
  observe.dispatched()
  d.reload('renderer-2')
  await vi.waitFor(async () => expect((await d.onHost()).ids).toEqual(['op-held']))
  d.host.runtime.onPtyData('pty-prompt', READY, 0)
  const answer = await send.handler(params, fromDesktop(d.host.runtime))
  expect(answer).toEqual({ delivery: { outcome: 'delivered' } })
  observe.answered({
    id: 'send',
    ok: true,
    result: answer,
    _meta: { runtimeId: d.host.runtime.getRuntimeId() }
  })
  // The host still shows its claimed copy to this window; the Dismiss must reach it.
  expect((await d.onHost()).ids).toEqual(['op-held'])
  await dismiss.handler({ id: 'op-held' }, d.window('renderer-2'))
  await vi.waitFor(async () => expect((await d.onHost()).ids).toEqual([]))
  d.reconnect()
  d.reload('renderer-3')
  expect((await d.onLocal('renderer-3')).ids).toEqual([])
  expect((await d.onHost()).ids).toEqual([])
})
