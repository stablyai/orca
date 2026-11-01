import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

import type { HostServerConnectEvent } from './ssh-host-server-connect-events'
import {
  resolveHostServerOnConnect,
  type HostServerOnConnectDeps
} from './ssh-host-server-on-connect'
import { hostServerDepsStub } from './ssh-host-server-on-connect-test-deps'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

const deps = hostServerDepsStub

async function eventsOf(d: HostServerOnConnectDeps): Promise<HostServerConnectEvent[]> {
  await resolveHostServerOnConnect(target, d).catch(() => undefined)
  return vi.mocked(d.report).mock.calls.map(([, event]) => event)
}

function decided(events: HostServerConnectEvent[]) {
  const found = events.filter((event) => event.kind === 'decided')
  expect(found).toHaveLength(1)
  return found[0]
}

describe('connect-decision telemetry', () => {
  it('still reports, as failed, a decision that throws, and a throwing reporter never fails a connect', async () => {
    const d = deps({
      managedEnvironmentId: () => 'env-9',
      ensureTunnel: async () => {
        throw new Error('tunnel failed')
      }
    })
    expect(decided(await eventsOf(d))).toMatchObject({ outcome: 'relay', reason: 'failed' })

    const throwing = deps({
      report: () => {
        throw new Error('telemetry broke')
      }
    })
    await expect(resolveHostServerOnConnect(target, throwing)).resolves.toMatchObject({
      route: 'managed'
    })
  })
})
