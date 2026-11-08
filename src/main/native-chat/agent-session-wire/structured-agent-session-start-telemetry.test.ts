import { beforeEach, expect, it, vi } from 'vitest'
import { track } from '../../telemetry/client'
import {
  CALLER,
  attachParams,
  hostTestState
} from './host/testing/structured-agent-session-host-test-harness'
import './host/testing/structured-agent-session-create-test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
beforeEach(() => vi.mocked(track).mockClear())

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
