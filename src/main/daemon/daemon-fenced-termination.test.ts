import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { TerminalHost } from './terminal-host'
import { handleDaemonFencedTermination } from './daemon-fenced-termination'
import { FENCED_TERMINATION_PROTOCOL_VERSION } from './daemon-protocol-version'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
afterEach(async () => {
  if (harness) {
    await harness.adapter.disconnectOnly()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    harness = undefined
  }
})

describe('fenced daemon kill protocol', () => {
  it('never sends conditional fields to an old daemon that would ignore them', async () => {
    const adapter = new DaemonPtyAdapter({
      socketPath: '/unused',
      tokenPath: '/unused',
      protocolVersion: 49
    })
    const request = vi.spyOn(adapter['client'], 'request')
    expect(adapter.supportsFencedTermination('pty')).toBe(false)
    await expect(
      adapter.killFenced({
        id: 'pty',
        expectedIncarnationId: 'A',
        requireNoAgentOwner: true,
        requireUnattached: true
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unsupported' })
    expect(request).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it('checks identity across a real daemon control connection', async () => {
    const handle = createMockSubprocess()
    harness = await startDaemonAdapterHarness(() => handle)
    const created = await harness.adapter.spawn({ sessionId: 'pty', cols: 80, rows: 24 })
    expect(created.incarnationId).toBeTruthy()
    const before = (await harness.adapter.listProcesses()).length
    await expect(
      harness.adapter.killFenced({
        id: 'pty',
        expectedIncarnationId: 'old-incarnation',
        requireNoAgentOwner: false,
        requireUnattached: false
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'replaced' })
    expect((await harness.adapter.listProcesses()).length).toBe(before)
    expect(handle.forceKill).not.toHaveBeenCalled()
    if (!created.incarnationId) {
      throw new Error('Expected incarnation')
    }
    await expect(
      harness.adapter.killFenced({
        id: 'pty',
        expectedIncarnationId: created.incarnationId,
        requireNoAgentOwner: false,
        requireUnattached: false
      })
    ).resolves.toEqual({ outcome: 'ended' })
  })

  it('checks a newly spawned owner after a replaced request populated the inventory cache', async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    const router = new DaemonPtyRouter({ current: harness.adapter, legacy: [] })
    await router.spawn({ sessionId: 'existing', cols: 80, rows: 24 })
    await expect(
      router.killFenced({
        id: 'existing',
        expectedIncarnationId: 'replaced-incarnation',
        requireNoAgentOwner: true,
        requireUnattached: false
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'replaced' })

    const created = await router.spawn({ sessionId: 'new-session', cols: 80, rows: 24 })
    if (!created.incarnationId) {
      throw new Error('Expected incarnation')
    }
    const kill = vi.spyOn(harness.adapter, 'killFenced')
    const request = {
      id: created.id,
      expectedIncarnationId: created.incarnationId,
      requireNoAgentOwner: true,
      requireUnattached: false
    }

    await expect(router.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
    expect(kill).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('refresh discovers post-startup sessions and dispatches checked termination without another scan', async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    const router = new DaemonPtyRouter({ current: harness.adapter, legacy: [] })
    await router.discoverLegacySessions()
    const created = await harness.adapter.spawn({
      sessionId: 'discovered-after-startup',
      cols: 80,
      rows: 24
    })
    if (!created.incarnationId) {
      throw new Error('Expected incarnation')
    }
    expect(router.supportsFencedTermination(created.id)).toBe(false)
    const listing = vi.spyOn(harness.adapter, 'listProcesses')
    const spawn = vi.spyOn(harness.adapter, 'spawn')
    const attach = vi.spyOn(harness.adapter, 'attach')
    const kill = vi.spyOn(harness.adapter, 'killFenced')
    const request = {
      id: created.id,
      expectedIncarnationId: created.incarnationId,
      requireNoAgentOwner: true,
      requireUnattached: false
    }

    await expect(router.listProcesses()).resolves.toEqual([
      expect.objectContaining({ id: created.id, incarnationId: created.incarnationId })
    ])
    expect(router.supportsFencedTermination(created.id)).toBe(true)
    await expect(router.killFenced(request)).resolves.toEqual({ outcome: 'ended' })
    expect(kill).toHaveBeenCalledExactlyOnceWith(request)
    expect(listing).toHaveBeenCalledOnce()
    expect(spawn).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })

  it('refresh never advertises fenced capability for a discovered old-generation owner', async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    const old = new DaemonPtyAdapter({
      socketPath: '/unused',
      tokenPath: '/unused',
      protocolVersion: FENCED_TERMINATION_PROTOCOL_VERSION - 1
    })
    const listing = vi.spyOn(old, 'listProcesses').mockResolvedValue([])
    const kill = vi.spyOn(old, 'killFenced')
    const router = new DaemonPtyRouter({ current: harness.adapter, legacy: [old] })
    await router.discoverLegacySessions()
    listing.mockResolvedValue([
      { id: 'old-generation', incarnationId: 'old', cwd: '', title: 'old' }
    ])

    await router.listProcesses()
    expect(router.supportsFencedTermination('old-generation')).toBe(false)
    await expect(
      router.killFenced({
        id: 'old-generation',
        expectedIncarnationId: 'old',
        requireNoAgentOwner: true,
        requireUnattached: true
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unsupported' })
    expect(kill).not.toHaveBeenCalled()
    expect(listing).toHaveBeenCalledTimes(2)
    old.dispose()
  })

  it('refresh removes prior capability authority when generations report the same identity', async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    const other = new DaemonPtyAdapter({
      socketPath: '/unused',
      tokenPath: '/unused',
      protocolVersion: FENCED_TERMINATION_PROTOCOL_VERSION
    })
    const listing = vi.spyOn(other, 'listProcesses').mockResolvedValue([])
    const router = new DaemonPtyRouter({ current: harness.adapter, legacy: [other] })
    const created = await router.spawn({
      sessionId: 'ambiguous',
      isNewSession: true,
      cols: 80,
      rows: 24
    })
    if (!created.incarnationId) {
      throw new Error('Expected incarnation')
    }
    expect(router.supportsFencedTermination(created.id)).toBe(true)
    listing.mockResolvedValue([
      { id: created.id, incarnationId: created.incarnationId, cwd: '', title: 'duplicate' }
    ])
    const currentKill = vi.spyOn(harness.adapter, 'killFenced')
    const otherKill = vi.spyOn(other, 'killFenced')

    await expect(router.listProcesses()).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(router.supportsFencedTermination(created.id)).toBe(false)
    await expect(
      router.killFenced({
        id: created.id,
        expectedIncarnationId: created.incarnationId,
        requireNoAgentOwner: true,
        requireUnattached: true
      })
    ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
    expect(currentKill).not.toHaveBeenCalled()
    expect(otherKill).not.toHaveBeenCalled()
    other.dispose()
  })

  it('leaves pending preparation and input untouched on refusal', async () => {
    const handle = createMockSubprocess()
    const host = new TerminalHost({ spawnSubprocess: () => handle })
    const created = await host.createOrAttach({
      sessionId: 'pty',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const preparations = { cancel: vi.fn() }
    const attachments = { clearInput: vi.fn() }
    await expect(
      handleDaemonFencedTermination(
        { sessionId: 'pty', expectedIncarnationId: created.incarnationId, requireUnattached: true },
        { host, preparations, attachments }
      )
    ).resolves.toEqual({ outcome: 'refused', reason: 'attached' })
    expect(preparations.cancel).not.toHaveBeenCalled()
    expect(attachments.clearInput).not.toHaveBeenCalled()
    handle._simulateExit(0)
    await host.dispose()
  })
})
