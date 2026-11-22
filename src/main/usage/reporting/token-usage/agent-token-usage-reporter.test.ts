import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentTokenUsageDaily } from '../../../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import { AgentTokenUsageReporter } from './agent-token-usage-reporter'

const SESSION_ID = '6f1c2d4e-8a9b-4c3d-9e2f-1a2b3c4d5e6f'
const tokens = (input: number) => ({
  input_tokens: input,
  output_tokens: input * 2,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0
})

let dir: string | null = null
afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function setup(initialState?: unknown) {
  dir = await mkdtemp(join(tmpdir(), 'token-usage-'))
  const file = join(dir, 'state.json')
  if (initialState) {
    await writeFile(file, JSON.stringify(initialState))
  }
  const sent: AgentTokenUsageDaily[] = []
  let now = new Date('2026-11-20T10:00:00Z')
  const reporter = new AgentTokenUsageReporter(
    file,
    'claude',
    async (ids) => ids.map(() => SESSION_ID),
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
    sent,
    reporter,
    at: (iso: string) => {
      now = new Date(iso)
    }
  }
}

describe('AgentTokenUsageReporter', () => {
  it('sends only growth after the v1 snapshot, once per finished UTC day', async () => {
    const { reporter, sent, at, file } = await setup({
      schemaVersion: 1,
      snapshots: [
        { ...tokens(100), provider: 'claude', analytics_session_id: SESSION_ID, revision: 3 }
      ]
    })
    await reporter.report([{ providerSessionId: 'a', ...tokens(130) }])
    await reporter.report([{ providerSessionId: 'a', ...tokens(150) }])
    expect(sent).toEqual([])

    at('2026-11-21T00:05:00Z')
    await reporter.report([{ providerSessionId: 'a', ...tokens(150) }])
    expect(sent).toEqual([{ ...tokens(50), provider: 'claude', usage_day: '2026-11-20' }])
    await reporter.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 2, days: [] })
  })

  it('never reports history found by the first scan', async () => {
    const { reporter, sent, at } = await setup()
    await reporter.report([{ providerSessionId: 'a', ...tokens(1000) }])
    at('2026-11-21T00:05:00Z')
    await reporter.report([{ providerSessionId: 'a', ...tokens(1000) }])
    expect(sent).toEqual([])
  })
})
