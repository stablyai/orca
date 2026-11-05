import { beforeEach, expect, it, vi } from 'vitest'
import { track } from '../../telemetry/client'
import { CALLER, attachParams, hostTestState } from './structured-agent-session-host-test-harness'
import { createTestParams } from './structured-agent-session-create-test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
beforeEach(() => vi.mocked(track).mockClear())

it('does not count empty conversation creation or its replay as an agent process start', async () => {
  const { host, acquire } = hostTestState()
  const params = createTestParams()
  expect(await host.create(CALLER, params)).toMatchObject({ ok: true })
  expect(await host.create(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  expect(acquire).not.toHaveBeenCalled()
  expect(track).not.toHaveBeenCalled()
})

it('counts a proved acquisition once across replayed attachment', async () => {
  const { host, acquire } = hostTestState()
  const params = attachParams()
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  expect(acquire).toHaveBeenCalledOnce()
  expect(track).toHaveBeenCalledExactlyOnceWith(
    'agent_started',
    expect.objectContaining({
      semantics_version: 2,
      backend: 'structured',
      agent_kind: 'codex',
      launch_source: 'unknown'
    })
  )
})

it('does not count an acquired process when durable ownership proof fails', async () => {
  const { host, store, acquire } = hostTestState()
  vi.spyOn(store, 'proveOwner').mockRejectedValueOnce(new Error('ownership proof failed'))
  await host.attach(CALLER, attachParams()).then(
    (result) => expect(result.ok).toBe(false),
    (error) => expect(error).toBeInstanceOf(Error)
  )
  expect(acquire).toHaveBeenCalledOnce()
  expect(store.getRecord(attachParams().envelope.sessionId)?.lease.claimStatus).not.toBe('live')
  expect(track).not.toHaveBeenCalled()
})

it('keeps a proved process live when telemetry capture fails', async () => {
  const { host, store } = hostTestState()
  const params = attachParams()
  vi.mocked(track).mockImplementationOnce(() => {
    throw new Error('telemetry unavailable')
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  expect(store.getRecord(params.envelope.sessionId)?.lease.claimStatus).toBe('live')
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true, replayed: true })
  expect(track).toHaveBeenCalledOnce()
})
