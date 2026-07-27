import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureRemoteServerUpdater } from '../../remote-server-updater'
import { STATUS_METHODS } from './status'
import { UPDATER_METHODS } from './updater'

const snapshot = {
  appVersion: '1.5.0',
  runtimeId: 'runtime-rpc',
  support: { installMode: 'interactive', automatic: true, reason: 'available' },
  status: { state: 'available', version: '1.5.1', changelog: null },
  revision: 2
} as const

function handler(methods: typeof UPDATER_METHODS, name: string) {
  const method = methods.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Missing method ${name}`)
  }
  return method.handler
}

describe('runtime updater RPC methods', () => {
  const getSnapshot = vi.fn(() => snapshot)
  const wait = vi.fn(async () => ({ ...snapshot, timedOut: false }))
  const check = vi.fn(() => snapshot)
  const download = vi.fn(() => snapshot)
  const install = vi.fn(() => ({
    accepted: true as const,
    fromVersion: '1.5.0',
    targetVersion: '1.5.1',
    runtimeId: 'runtime-rpc'
  }))
  const runtime = {
    getRuntimeId: () => 'runtime-rpc',
    getStatus: () => ({ runtimeId: 'runtime-rpc', liveTabCount: 2, liveLeafCount: 3 })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    configureRemoteServerUpdater({ getSnapshot, wait, check, download, install })
  })

  it('exposes status and each update transition', async () => {
    const context = { runtime } as never
    expect(await handler(UPDATER_METHODS, 'updater.getStatus')(undefined, context)).toBe(snapshot)
    expect(
      await handler(UPDATER_METHODS, 'updater.check')(
        { includePrerelease: false, includePerfPrerelease: true },
        context
      )
    ).toBe(snapshot)
    expect(await handler(UPDATER_METHODS, 'updater.download')(undefined, context)).toBe(snapshot)
    expect(await handler(UPDATER_METHODS, 'updater.install')(undefined, context)).toMatchObject({
      accepted: true,
      runtimeId: 'runtime-rpc'
    })
    expect(check).toHaveBeenCalledWith('runtime-rpc', {
      includePrerelease: false,
      includePerfPrerelease: true
    })
  })

  it('long-polls for the next status revision, forwarding the abort signal', async () => {
    const context = { runtime, signal: undefined } as never
    const result = await handler(UPDATER_METHODS, 'updater.wait')(
      { afterRevision: 2, timeoutMs: 25_000 },
      context
    )
    expect(result).toMatchObject({ timedOut: false, revision: 2 })
    expect(wait).toHaveBeenCalledWith('runtime-rpc', 2, 25_000, undefined)
  })

  it('enriches status.get without changing the runtime status source', async () => {
    const result = await handler(STATUS_METHODS, 'status.get')(undefined, { runtime } as never)
    expect(result).toEqual({
      runtimeId: 'runtime-rpc',
      liveTabCount: 2,
      liveLeafCount: 3,
      appVersion: '1.5.0',
      remoteUpdateSupport: snapshot.support
    })
  })
})
