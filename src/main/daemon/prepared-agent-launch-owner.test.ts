import type { RawPtySpawnObserver } from './pty-subprocess'
import { fingerprintPreparedAgentLaunch } from './prepared-agent-launch-payload'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { PreparedAgentLaunchOwner } from './prepared-agent-launch-owner'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import {
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchIdentity
} from '../../shared/prepared-agent-launch'

const NOW = 1_800_000_000_000
const claim = {
  kind: 'fresh-launch',
  agent: 'codex',
  keyId: 'key',
  identityDigest: 'a'.repeat(43),
  worktreeScopeDigest: 'b'.repeat(43),
  digestVersion: 1
} as const
const surface = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '12345678-1234-4234-8234-123456789abc',
  terminalHandle: 'term_agent'
}
const launch = {
  sessionId: 'agent',
  cols: 80,
  rows: 24,
  command: 'cx',
  env: { TASK: 'whole\ncontent' }
}

function result(): CreateOrAttachResult {
  return {
    isNew: true,
    snapshot: null,
    pid: 42,
    shellState: 'ready',
    wslDistro: null,
    attachToken: Symbol(),
    incarnationId: randomUUID()
  }
}
async function fixture(
  create?: (opts: InternalCreateOrAttachOptions) => Promise<CreateOrAttachResult>,
  withSetup = true
) {
  vi.useFakeTimers({ now: NOW })
  const calls: InternalCreateOrAttachOptions[] = []
  const observers: RawPtySpawnObserver[] = []
  const release = vi.fn()
  const owner = new PreparedAgentLaunchOwner({
    owners: new ClaimedAgentPtyOwnerRegistry(),
    isAlive: () => true,
    reserveCapacity: () => release,
    create: async (opts) => {
      calls.push(opts)
      const observer = opts.rawSpawnObserver?.()
      if (observer) {
        observers.push(observer)
        observer.onSelected()
      }
      opts.reservedCapacity?.()
      return create ? create(opts) : result()
    }
  })
  const operationId = `${NOW}-${'a'.repeat(32)}`
  const attemptId = randomUUID()
  const payload = {
    launch,
    ...(withSetup
      ? {
          setup: {
            spawn: { sessionId: 'setup', cols: 80, rows: 24 },
            attemptId,
            deadline: NOW + 7_200_000
          }
        }
      : {})
  }
  const prepared = await owner.handle({
    action: 'prepare',
    operationId,
    fingerprint: fingerprintPreparedAgentLaunch(payload),
    claim,
    surface
  })
  if (!isPreparedAgentLaunchStatus(prepared)) {
    throw new Error('missing preparation')
  }
  const identity: PreparedAgentLaunchIdentity = prepared
  const accept = () => owner.handle({ action: 'accept', identity, ...payload })
  const zero = () => observers[0].onData(`\r\n__ORCA_SETUP_COMPLETE__:${attemptId}:0\r\n`)
  const status = () => owner.handle({ action: 'status', identity })
  return { owner, identity, calls, observers, release, accept, zero, status, attemptId }
}
afterEach(() => vi.useRealTimers())

describe('prepared Setup execution owner', () => {
  it('launches an immediate terminal through the same canonical owner without Setup or command changes', async () => {
    const f = await fixture(undefined, false)
    await f.accept()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject(launch)
    expect(await f.status()).toMatchObject({ execution: 'started', surface })
    await f.accept()
    expect(f.calls).toHaveLength(1)
  })

  it('retires a confirmed failed native attempt after its physical disposition settles', async () => {
    const completion = Promise.withResolvers<void>()
    const f = await fixture(async (opts) => {
      opts.onCreationDisposition?.({ kind: 'failed', completion: completion.promise })
      throw new Error('native spawn failed')
    }, false)
    await f.accept()
    await vi.advanceTimersByTimeAsync(0)
    expect(await f.status()).toMatchObject({ execution: 'unknown', retirement: 'unknown' })
    completion.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(await f.status()).toMatchObject({ execution: 'settled', retirement: 'unused-retired' })
    expect(f.owner.pending).toBe(0)
    await f.accept()
    expect(f.calls).toHaveLength(1)
  })

  it.each([false, true])(
    'retires retained physical work on confirmed exit after publication failure=%s',
    async (publicationFailed) => {
      const completion = Promise.withResolvers<void>()
      const f = await fixture(async (opts) => {
        opts.onPhysicalOwner?.(completion.promise, () => null)
        if (publicationFailed) {
          throw new Error('Session publication failed')
        }
        return result()
      }, false)
      await f.accept()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.owner.pending).toBe(1)
      completion.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(await f.status()).toMatchObject({ execution: 'settled', retirement: 'unused-retired' })
      expect(f.owner.pending).toBe(0)
      await f.accept()
      expect(f.calls).toHaveLength(1)
    }
  )

  it('does not publish a dead canonical owner when physical exit beats the spawn reply', async () => {
    const completion = Promise.withResolvers<void>()
    const f = await fixture(async (opts) => {
      opts.onPhysicalOwner?.(completion.promise, () => 0)
      opts.onCreationDisposition?.({
        kind: 'physical',
        completion: completion.promise,
        exitCode: () => 0
      })
      completion.resolve()
      await Promise.resolve()
      return result()
    }, false)
    await f.accept()
    await vi.advanceTimersByTimeAsync(0)
    expect(await f.status()).toMatchObject({ execution: 'settled', retirement: 'unused-retired' })
    const next = await f.owner.handle({
      action: 'prepare',
      operationId: `${NOW}-${'b'.repeat(32)}`,
      fingerprint: 'next',
      claim: { ...claim, identityDigest: 'c'.repeat(43) },
      surface
    })
    expect(next).toMatchObject({ accepted: false, execution: 'not-dispatched' })
  })

  it('never admits an unaccepted reservation after its preparation deadline', async () => {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await f.accept()).toMatchObject({ accepted: false, retirement: 'unused-retired' })
    expect(f.calls).toHaveLength(0)
  })
  it('accepts both processes before Setup, sees a split raw marker before publication and launches the unchanged payload once', async () => {
    const setupReply = Promise.withResolvers<CreateOrAttachResult>()
    const f = await fixture((opts) =>
      opts.sessionId === 'setup' ? setupReply.promise : Promise.resolve(result())
    )
    expect(f.calls).toHaveLength(0)
    await f.accept()
    expect(f.calls).toHaveLength(1)
    const marker = `\n__ORCA_SETUP_COMPLETE__:${f.attemptId}:0\r\n`
    f.observers[0].onData('x'.repeat(100_000) + marker.slice(0, -2))
    expect(f.calls).toHaveLength(1)
    f.observers[0].onData(marker.slice(-2))
    await Promise.resolve()
    expect(f.calls).toHaveLength(2)
    f.zero()
    f.observers[0].onExit()
    setupReply.resolve(result())
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls[1]).toMatchObject(launch)
    expect(f.calls).toHaveLength(2)
    expect(await f.status()).toMatchObject({
      accepted: true,
      execution: 'started',
      physical: { sessionId: 'agent' }
    })
    expect(await f.accept()).toMatchObject({ execution: 'started' })
    expect(f.calls).toHaveLength(2)
  })

  it.each(['cancel', 'deadline', 'nonzero', 'exit'] as const)(
    'retires unstarted execution on %s and ignores late zero',
    async (reason) => {
      const f = await fixture()
      await f.accept()
      if (reason === 'cancel') {
        await f.owner.handle({ action: 'cancel', identity: f.identity })
      }
      if (reason === 'deadline') {
        await vi.advanceTimersByTimeAsync(7_200_000)
      }
      if (reason === 'nonzero') {
        f.observers[0].onData(`\n__ORCA_SETUP_COMPLETE__:${f.attemptId}:9\n`)
      }
      if (reason === 'exit') {
        f.observers[0].onExit()
      }
      f.zero()
      await vi.advanceTimersByTimeAsync(0)
      expect(f.calls).toHaveLength(1)
      expect(await f.status()).toMatchObject({ execution: 'settled', retirement: 'unused-retired' })
      expect(f.release).toHaveBeenCalledTimes(1)
    }
  )

  it('subscriber timeout detaches without cancelling the accepted dependency; zero wins over later cancel', async () => {
    const f = await fixture()
    await f.accept()
    const waiting = f.owner.handle({ action: 'wait', identity: f.identity, timeoutMs: 20 })
    await vi.advanceTimersByTimeAsync(20)
    expect(await waiting).toMatchObject({
      accepted: true,
      execution: 'not-dispatched',
      retirement: 'retained-pending'
    })
    expect(f.release).not.toHaveBeenCalled()
    f.zero()
    expect(await f.owner.handle({ action: 'cancel', identity: f.identity })).toMatchObject({
      accepted: true,
      execution: 'dispatching'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(2)
    expect(await f.status()).toMatchObject({ execution: 'started', retirement: 'retained-live' })
  })

  it('requires exact generation, retains uncertain native creation and never retries it', async () => {
    const f = await fixture(async (opts) => {
      if (opts.sessionId === 'agent') {
        opts.onCreationDisposition?.({ kind: 'unknown' })
        throw new Error('reply lost')
      }
      return result()
    })
    await f.accept()
    f.zero()
    await vi.advanceTimersByTimeAsync(0)
    await expect(
      f.owner.handle({ action: 'cancel', identity: { ...f.identity, daemonGeneration: 'another' } })
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(await f.owner.handle({ action: 'retireInput', identity: f.identity })).toMatchObject({
      execution: 'unknown',
      retirement: 'unknown'
    })
    await f.accept()
    expect(f.calls).toHaveLength(2)
    expect(f.owner.pending).toBe(1)
  })
})
