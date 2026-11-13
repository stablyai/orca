import { describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentSetup } from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { startCodexBrokerSession } from './codex-broker-driver'

const START = {
  brokerId: 'brk_1',
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: 'ABCD-1234',
  expiresAt: 1_000
}

function harness(
  statuses: { status: 'pending' | 'active' | 'failed'; error?: string }[],
  start = START,
  stepMs = 100
) {
  let clock = 0
  const updates: OrcaCloudAgentSetup[] = []
  const client = {
    startCodexBroker: vi.fn(async () => start),
    codexBrokerStatus: vi.fn(async () => statuses.shift() ?? { status: 'pending' as const }),
    cancelCodexBroker: vi.fn(async () => {})
  }
  const session = startCodexBrokerSession({
    client,
    onUpdate: (setup) => updates.push(setup),
    now: () => clock,
    sleep: async () => {
      clock += stepMs
    }
  })
  return { session, updates, client }
}

describe('startCodexBrokerSession', () => {
  it('shows the device code, then reports saved once the broker is active', async () => {
    const { session, updates } = harness([{ status: 'pending' }, { status: 'active' }])
    await session.done
    expect(updates.map((u) => u.phase)).toEqual(['preparing', 'device', 'saved'])
    expect(updates[1]).toMatchObject({ userCode: 'ABCD-1234' })
  })

  it('reports why the broker failed', async () => {
    const { session, updates } = harness([{ status: 'failed', error: 'not_a_chatgpt_login' }])
    await session.done
    expect(updates.at(-1)).toEqual({ phase: 'failed', error: 'not_a_chatgpt_login' })
  })

  it('RS-3: device-code sign-in turned off on the ChatGPT account keeps its own reason', async () => {
    const { session, updates } = harness([{ status: 'failed', error: 'device_auth_disabled' }])
    await session.done
    expect(updates.at(-1)).toEqual({ phase: 'failed', error: 'device_auth_disabled' })
  })

  it('cancels the broker when the code expires', async () => {
    const { session, updates, client } = harness(
      Array.from({ length: 20 }, () => ({ status: 'pending' as const }))
    )
    await session.done
    expect(updates.at(-1)).toEqual({ phase: 'failed', error: 'code_expired' })
    expect(client.cancelCodexBroker).toHaveBeenCalledWith('brk_1')
  })

  it('stops polling and cancels the broker on cancel', async () => {
    const { session, client, updates } = harness([])
    await Promise.resolve()
    await Promise.resolve()
    await session.cancel()
    await session.done
    expect(client.cancelCodexBroker).toHaveBeenCalledWith('brk_1')
    expect(updates.map((u) => u.phase)).not.toContain('saved')
  })

  it('never shows a sign-in page that is not OpenAI', async () => {
    const { session, updates, client } = harness([], {
      ...START,
      verificationUrl: 'https://evil.example/device'
    })
    await session.done
    expect(updates.map((u) => u.phase)).toEqual(['preparing', 'failed'])
    expect(client.cancelCodexBroker).toHaveBeenCalledWith('brk_1')
  })

  it('caps the wait even if the broker says the code lasts for days', async () => {
    // Each fake poll moves the clock a minute: the 20-minute cap ends it, not the broker's date.
    const { session, updates } = harness(
      Array.from({ length: 30 }, () => ({ status: 'pending' as const })),
      { ...START, expiresAt: Number.MAX_SAFE_INTEGER },
      60_000
    )
    await session.done
    expect(updates[1]).toMatchObject({ phase: 'device', expiresAt: 20 * 60_000 })
    expect(updates.at(-1)).toEqual({ phase: 'failed', error: 'code_expired' })
  })

  it('maps a refused start to a code', async () => {
    const updates: OrcaCloudAgentSetup[] = []
    const session = startCodexBrokerSession({
      client: {
        startCodexBroker: async () => {
          throw new Error('boom')
        },
        codexBrokerStatus: vi.fn(),
        cancelCodexBroker: vi.fn()
      },
      onUpdate: (setup) => updates.push(setup)
    })
    await session.done
    expect(updates.at(-1)).toEqual({ phase: 'failed', error: 'unknown' })
  })
})
