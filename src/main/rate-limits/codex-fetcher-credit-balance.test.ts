import { registerScriptedProviderChild } from '../provider-process/mock-provider-process-group.test-support'
import type * as ProcessHostModule from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { AcpScriptedAgent } from '../acp/acp-scripted-agent.test-support'
import {
  completeFakeSpawn,
  createFakePipedChild
} from '../../shared/__fixtures__/fake-spawned-child'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock } = vi.hoisted(() => ({ childSpawnMock: vi.fn() }))

// The probe's child runs in-process here; the worker transport has its own suite.
vi.mock(
  '../worker-thread-child-process/worker-thread-child-process',
  () =>
    import('../worker-thread-child-process/worker-thread-child-process-in-process.test-fixtures')
)
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./codex-auth-presence', () => ({
  probeCodexAuthPresence: vi.fn(async () => 'present')
}))

// The recovery's supervised stop imports the process-table reader, which needs the real execFile.
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  startCodexStateDbBackfillRecoveryInBackground: vi.fn()
}))

import { fetchCodexRateLimits } from './codex-fetcher'
import { getAppEnvironment } from '../../shared/app-environment'

async function fetchWithRateLimits(rateLimits: unknown) {
  const agent = new AcpScriptedAgent()
  const child = registerScriptedProviderChild(
    Object.assign(createFakePipedChild(9_999_999), {
      stdin: agent.stdin,
      stdout: agent.stdout
    })
  )
  agent.on('initialize', (frame) => setTimeout(() => agent.reply(frame, {}), 0))
  agent.on('account/rateLimits/read', (frame) =>
    setTimeout(() => agent.reply(frame, { rateLimits }), 0)
  )
  child.stdin.once('finish', () => completeFakeSpawn(child))
  childSpawnMock.mockReturnValue(child)
  const resultPromise = fetchCodexRateLimits({
    codexHomePath: getAppEnvironment().getPath('userData')
  })
  await vi.waitFor(() =>
    expect(agent.frames.some((frame) => frame.method === 'initialize')).toBe(true)
  )
  await vi.advanceTimersByTimeAsync(1)
  await vi.advanceTimersByTimeAsync(1)
  return resultPromise
}

describe('fetchCodexRateLimits credit balance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('maps the RPC credits object into a Codex credit-count balance', async () => {
    const result = await fetchWithRateLimits({
      primary: { usedPercent: 20, windowDurationMins: 10079 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '500' }
    })

    expect(result.extraUsage).toMatchObject({
      balance: 500,
      unit: 'credits',
      unlimited: false,
      enabled: true
    })
  })

  it('omits the Codex balance when the account has no credits', async () => {
    const result = await fetchWithRateLimits({
      primary: { usedPercent: 20, windowDurationMins: 10079 },
      credits: { hasCredits: false, unlimited: false, balance: '0' }
    })

    expect(result.extraUsage ?? null).toBeNull()
  })
  it.each([undefined, null, '', '  ', 'invalid', 'Infinity', '1e999'])(
    'omits unavailable credit balance %s despite hasCredits',
    async (balance) => {
      const result = await fetchWithRateLimits({
        primary: { usedPercent: 20, windowDurationMins: 10079 },
        credits: { hasCredits: true, unlimited: false, balance }
      })
      expect(result.extraUsage ?? null).toBeNull()
    }
  )

  it('preserves an explicitly reported zero credit balance', async () => {
    const result = await fetchWithRateLimits({
      primary: { usedPercent: 20, windowDurationMins: 10079 },
      credits: { hasCredits: true, unlimited: false, balance: '0' }
    })
    expect(result.extraUsage).toMatchObject({ unit: 'credits', unlimited: false, balance: 0 })
  })

  it('keeps the unlimited indication without requiring a numeric balance', async () => {
    const result = await fetchWithRateLimits({
      primary: { usedPercent: 20, windowDurationMins: 10079 },
      credits: { hasCredits: false, unlimited: true, balance: null }
    })
    expect(result.extraUsage).toMatchObject({ unit: 'credits', unlimited: true, enabled: true })
  })
})

vi.mock('@orca/process-host', async (original) => {
  const actual = await original<typeof ProcessHostModule>()
  return {
    ...actual,
    spawnProcess: (spec: ProcessSpec) =>
      spec.program === 'codex'
        ? childSpawnMock(spec.program, spec.args ?? [], spec)
        : actual.spawnProcess(spec)
  }
})
