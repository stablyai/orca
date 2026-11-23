import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentTokenUsageDaily } from '../../../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import { AgentTokenUsageReporter } from './agent-token-usage-reporter'

const tokens = (input: number) => ({
  input_tokens: input,
  output_tokens: input * 2,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0
})
// Local noon keeps the local calendar day stable in any time zone.
const noon = (day: number) => new Date(2026, 10, day, 12)

let dir: string | null = null
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function setup(legacy = false) {
  dir = await mkdtemp(join(tmpdir(), 'token-usage-'))
  const file = join(dir, 'daily.json')
  const legacyFile = join(dir, 'legacy.json')
  if (legacy) {
    await writeFile(legacyFile, JSON.stringify({ schemaVersion: 1, snapshots: [] }))
  }
  const sent: AgentTokenUsageDaily[] = []
  let now = noon(20)
  const create = () =>
    new AgentTokenUsageReporter(
      file,
      legacyFile,
      'claude',
      {
        isEnabled: async () => true,
        capture: async (row) => {
          sent.push(row)
          return true
        }
      },
      () => now
    )
  return {
    file,
    legacyFile,
    sent,
    create,
    at: (day: number) => {
      now = noon(day)
    }
  }
}

describe('AgentTokenUsageReporter', () => {
  it('sends each finished day under the day it was used, then only later growth', async () => {
    const { create, sent, at } = await setup()
    const reporter = create()
    await reporter.report([
      { day: '2026-11-19', ...tokens(500) },
      { day: '2026-11-20', ...tokens(100) }
    ])
    expect(sent).toEqual([])

    at(21)
    await reporter.report([
      { day: '2026-11-19', ...tokens(500) },
      { day: '2026-11-20', ...tokens(130) }
    ])
    // History from before the first run is never sent.
    expect(sent).toEqual([{ ...tokens(130), provider: 'claude', usage_day: '2026-11-20' }])

    await reporter.flush()
    const restarted = create()
    await restarted.report([{ day: '2026-11-20', ...tokens(150) }])
    expect(sent.slice(1)).toEqual([{ ...tokens(20), provider: 'claude', usage_day: '2026-11-20' }])
  })

  it('starts the day after an older build, then keeps every later day across a downgrade', async () => {
    const { create, sent, at, legacyFile } = await setup(true)
    const upgraded = create()
    await upgraded.report([{ day: '2026-11-20', ...tokens(40) }])
    await upgraded.flush()

    // The older build ran after a downgrade and rewrote its own file.
    await writeFile(legacyFile, JSON.stringify({ schemaVersion: 1, snapshots: [] }))
    at(23)
    // The daily state is intact, so the downgrade's days still count.
    const reupgraded = create()
    await reupgraded.report([
      { day: '2026-11-20', ...tokens(40) },
      { day: '2026-11-21', ...tokens(5) },
      { day: '2026-11-22', ...tokens(10) }
    ])
    // The upgrade day is left to the older build's event; every later day is sent.
    expect(sent).toEqual([
      { ...tokens(5), provider: 'claude', usage_day: '2026-11-21' },
      { ...tokens(10), provider: 'claude', usage_day: '2026-11-22' }
    ])
  })

  it('never reports a day on which a scan saw sharing turned off, or any earlier unsent day', async () => {
    const { create, sent, at } = await setup()
    const reporter = create()
    await reporter.report([])
    at(21)
    await reporter.pause()
    at(23)
    await reporter.report([
      { day: '2026-11-20', ...tokens(10) },
      { day: '2026-11-21', ...tokens(20) },
      { day: '2026-11-22', ...tokens(30) }
    ])
    // Unsent days up to the off day are dropped too; only later days are sent.
    expect(sent).toEqual([{ ...tokens(30), provider: 'claude', usage_day: '2026-11-22' }])
  })
})
