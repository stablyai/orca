import { describe, expect, it, vi } from 'vitest'
import type { PiDraftBridgeHello, PiDraftBridgeResponse } from '../../../pi/draft-bridge-protocol'
import type { PiDraftBridgeCapability } from '../../../pi/draft-bridge-client'
import type { PiDraftBridgePaths } from '../../../pi/draft-bridge-directory'
import { TerminalDraftCoordinator } from './terminal-draft-coordinator'

const paths = (token = 'bridge-token'): PiDraftBridgePaths => ({
  dir: '/tmp/bridge',
  session: { protocol: 1, token, paneKey: 'tab:leaf', createdAt: 1 }
})

const hello = (): PiDraftBridgeHello => ({
  protocol: 1,
  token: 'bridge-token',
  instanceId: 'abcdef123456',
  pid: 10,
  startedAt: 5,
  at: 10,
  capabilities: { capture: true, replace: true }
})

const supported = (): PiDraftBridgeCapability => ({
  supported: true,
  hello: hello(),
  processIncarnation: '10:5:abcdef123456'
})

const response = (value: Record<string, unknown>): PiDraftBridgeResponse => ({
  protocol: 1,
  token: 'bridge-token',
  id: 'request',
  ok: false,
  ...value
})

function createHarness() {
  let now = 1000
  let remoteText = 'first\nsecond\nthird\nfourth'
  let bridgeToken = 'bridge-token'
  const replace = vi.fn(async (_paths: PiDraftBridgePaths, text: string, baseToken: string) => {
    const current = `token:${remoteText}`
    if (baseToken !== current) {
      return response({ ok: false, error: 'conflict', text: remoteText, sourceToken: current })
    }
    remoteText = text
    return response({ ok: true, text, sourceToken: `token:${remoteText}` })
  })
  const deps = {
    readSession: () => paths(bridgeToken),
    readCapability: async (): Promise<PiDraftBridgeCapability> => supported(),
    capture: async () =>
      response({ ok: true, text: remoteText, sourceToken: `token:${remoteText}` }),
    replace,
    now: () => now
  }
  const coordinator = new TerminalDraftCoordinator('/tmp/user-data', deps)
  return {
    coordinator,
    replace,
    setNow: (value: number) => {
      now = value
    },
    setRemoteText: (value: string) => {
      remoteText = value
    },
    remoteText: () => remoteText,
    rotateBridge: () => {
      bridgeToken = 'new-token'
    }
  }
}

const desktop = { id: 'desktop-1', type: 'desktop' as const }
const mobile = { id: 'mobile-1', type: 'mobile' as const }

describe('TerminalDraftCoordinator', () => {
  it('captures the full multi-line draft and lets the editor replace a middle line', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({
      ptyId: 'pty-1',
      client: desktop
    })
    expect(begun).toMatchObject({ ok: true, epoch: 1, text: 'first\nsecond\nthird\nfourth' })
    if (!begun.ok) {
      return
    }
    const saved = await harness.coordinator.save({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'first\nsecond EDITED\nthird\nfourth',
      operationId: 'op-1'
    })
    expect(saved).toMatchObject({ ok: true, status: 'applied' })
    expect(harness.remoteText()).toBe('first\nsecond EDITED\nthird\nfourth')
  })

  it('rejects a second device until it explicitly takes over, then fences the old epoch', async () => {
    const harness = createHarness()
    const first = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!first.ok) {
      throw new Error('expected begin')
    }
    const locked = await harness.coordinator.begin({ ptyId: 'pty-1', client: mobile })
    expect(locked).toMatchObject({ ok: false, reason: 'locked', holder: { clientId: 'desktop-1' } })

    const taken = await harness.coordinator.begin({ ptyId: 'pty-1', client: mobile, force: true })
    expect(taken).toMatchObject({ ok: true })
    if (!taken.ok) {
      throw new Error('expected takeover')
    }
    expect(taken.epoch).toBe(first.epoch + 1)

    const stale = await harness.coordinator.save({
      ptyId: 'pty-1',
      client: desktop,
      epoch: first.epoch,
      baseToken: first.sourceToken,
      text: 'old device write',
      operationId: 'op-old'
    })
    expect(stale).toMatchObject({ ok: false, status: 'stale_lease' })
    expect(harness.remoteText()).toBe('first\nsecond\nthird\nfourth')
  })

  it('returns the terminal version on a conflict instead of overwriting it', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    harness.setRemoteText('first\nsecond typed on the host\nthird\nfourth')
    const saved = await harness.coordinator.save({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'first\nsecond EDITED\nthird\nfourth',
      operationId: 'op-conflict'
    })
    expect(saved).toMatchObject({
      ok: false,
      status: 'conflict',
      conflict: { text: 'first\nsecond typed on the host\nthird\nfourth' }
    })
    expect(harness.remoteText()).toBe('first\nsecond typed on the host\nthird\nfourth')
  })

  it('replays a save answer for the same operation id without a second write', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    const input = {
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'edited once',
      operationId: 'op-once'
    }
    const first = await harness.coordinator.save(input)
    const retry = await harness.coordinator.save(input)
    expect(first).toMatchObject({ ok: true, status: 'applied' })
    expect(retry).toMatchObject({ ok: true, status: 'applied', replayed: true })
    expect(harness.replace).toHaveBeenCalledTimes(1)
  })

  it('submits the draft and reports Enter acceptance separately from the save', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    const submitInput = vi.fn(async () => ({ accepted: true }))
    const submitted = await harness.coordinator.submit({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'send this once',
      operationId: 'op-submit',
      submitInput
    })
    expect(submitted).toMatchObject({ ok: true, status: 'submitted' })
    expect(harness.remoteText()).toBe('send this once')
    expect(submitInput).toHaveBeenCalledTimes(1)
  })

  it('does not claim a turn started when the Enter settlement is unknown', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    const submitted = await harness.coordinator.submit({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'maybe sent',
      operationId: 'op-unknown',
      submitInput: async () => ({
        accepted: false,
        writeSettlement: {
          outcome: 'unverifiable',
          reason: 'settlement_timeout',
          bytesHandedToTransport: true
        }
      })
    })
    expect(submitted).toMatchObject({ ok: true, status: 'submit_unknown' })
  })

  it('keeps an accepted draft when the host refused Enter', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    const submitted = await harness.coordinator.submit({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'saved only',
      operationId: 'op-refused',
      submitInput: async () => ({
        accepted: false,
        writeSettlement: { outcome: 'refused', reason: 'provider_refused_write' }
      })
    })
    expect(submitted).toMatchObject({
      ok: true,
      status: 'saved_not_submitted',
      submitRefused: true
    })
  })

  it('invalidates the lease when the agent process is replaced under the same PTY id', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    harness.rotateBridge()
    const saved = await harness.coordinator.save({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'new process must not inherit this lease',
      operationId: 'op-new-process'
    })
    expect(saved).toMatchObject({ ok: false, status: 'stale_lease' })
  })

  it('collapses overlapping submissions with the same operation id to one Enter', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    let releaseEnter: (() => void) | undefined
    const submitInput = vi.fn(
      () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          releaseEnter = () => resolve({ accepted: true })
        })
    )
    const input = {
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'send once',
      operationId: 'op-overlap',
      submitInput
    }
    const first = harness.coordinator.submit(input)
    const second = harness.coordinator.submit(input)
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseEnter?.()
    const results = await Promise.all([first, second])
    expect(results[0]).toMatchObject({ ok: true, status: 'submitted' })
    expect(results[1]).toMatchObject({ ok: true, status: 'submitted', replayed: true })
    expect(submitInput).toHaveBeenCalledTimes(1)
  })

  it('serializes a takeover behind an in-flight save and fences the old epoch afterwards', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    const saving = harness.coordinator.save({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'desktop save',
      operationId: 'op-inflight'
    })
    const takingOver = harness.coordinator.begin({
      ptyId: 'pty-1',
      client: mobile,
      force: true
    })
    expect(await saving).toMatchObject({ ok: true, status: 'applied' })
    const taken = await takingOver
    expect(taken).toMatchObject({ ok: true })
    if (!taken.ok) {
      throw new Error('expected takeover')
    }
    expect(taken.epoch).toBeGreaterThan(begun.epoch)
    const stale = await harness.coordinator.save({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: taken.sourceToken,
      text: 'desktop after takeover',
      operationId: 'op-after-takeover'
    })
    expect(stale).toMatchObject({ ok: false, status: 'stale_lease' })
  })

  it('does not reuse an epoch after release', async () => {
    const harness = createHarness()
    const first = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!first.ok) {
      throw new Error('expected begin')
    }
    expect(
      await harness.coordinator.release({
        ptyId: 'pty-1',
        epoch: first.epoch,
        client: desktop
      })
    ).toEqual({ ok: true })
    const second = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!second.ok) {
      throw new Error('expected reacquire')
    }
    expect(second.epoch).toBeGreaterThan(first.epoch)
  })

  it('expires an abandoned lease without writing anything', async () => {
    const harness = createHarness()
    const begun = await harness.coordinator.begin({ ptyId: 'pty-1', client: desktop })
    if (!begun.ok) {
      throw new Error('expected begin')
    }
    harness.setNow(1000 + 6 * 60_000)
    const saved = await harness.coordinator.save({
      ptyId: 'pty-1',
      client: desktop,
      epoch: begun.epoch,
      baseToken: begun.sourceToken,
      text: 'too late',
      operationId: 'op-expired'
    })
    expect(saved).toMatchObject({ ok: false, status: 'stale_lease' })
    expect(harness.remoteText()).toBe('first\nsecond\nthird\nfourth')
  })
})
