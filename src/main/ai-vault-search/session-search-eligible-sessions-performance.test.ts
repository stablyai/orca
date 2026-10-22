import { expect, it } from 'vitest'
import { addSyntheticSession, openSessionSearchHarness } from './session-search-engine-test-fixture'
import type { AiVaultSearchEligibleSessions } from '../../shared/ai-vault-search-eligible-sessions'

it.runIf(process.env.ORCA_CMD_J_EVALUATION === '1').each([
  { sessions: 20000, rows: 1 },
  { sessions: 1000, rows: 20 }
])(
  'budgets legacy prompt eligibility on $sessions sessions × $rows matching rows',
  async ({ sessions, rows }) => {
    const harness = await openSessionSearchHarness('ss-legacy-budget')
    try {
      const title = (id: number) =>
        `Task ${String(id).padStart(6, '0')}: Build a useful and complex feature for this workspace`
      harness.db.exec('BEGIN')
      for (let id = 1; id <= sessions; id++) {
        addSyntheticSession(harness.db, {
          id,
          rows,
          text: id <= 2 ? 'a raremarker refresh here' : 'ordinary history'
        })
        harness.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title(id), id)
      }
      harness.db.exec('COMMIT')
      const legacy: AiVaultSearchEligibleSessions = {
        providers: [],
        prompts: Array.from({ length: 20 }, (_, pane) => ({
          agent: 'claude',
          prompts: Array.from({ length: 20 }, (_, entry) => title(pane * 20 + entry + 1))
        }))
      }
      const provider: AiVaultSearchEligibleSessions = {
        providers: [{ agent: 'claude', sessionId: '1' }],
        prompts: []
      }
      const broadProvider: AiVaultSearchEligibleSessions = {
        providers: Array.from({ length: 400 }, (_, index) => ({
          agent: 'claude',
          sessionId: String(index + 1)
        })),
        prompts: []
      }
      const medians = new Map<string, number>()
      for (const [name, query, eligibleSessions] of [
        ['provider rare', 'raremarker', provider],
        ['provider broad', 'ordinary', broadProvider],
        ['legacy rare', 'raremarker', legacy],
        ['legacy broad', 'ordinary', legacy],
        ['mixed broad', 'ordinary', { ...legacy, providers: broadProvider.providers }],
        ['mixed rare', 'raremarker', { ...legacy, providers: provider.providers }],
        ['legacy typo', 'refersh', legacy]
      ] as const) {
        const timings: number[] = []
        for (let run = 0; run < 7; run++) {
          const started = performance.now()
          const result = harness.engine.search({
            query,
            eligibleSessions,
            includeOriginalExcerpt: true
          })
          timings.push(performance.now() - started)
          expect(result.hits.length).toBeGreaterThan(0)
        }
        timings.sort((a, b) => a - b)
        medians.set(name, timings[3])
        console.log(
          'Cmd+J legacy eligibility',
          JSON.stringify({ name, sessions, rows, medianMs: timings[3] })
        )
      }
      const baseline = medians.get('provider rare') ?? 0
      for (const name of ['legacy broad', 'mixed broad']) {
        expect(medians.get(name)).toBeLessThan((medians.get('provider broad') ?? 0) * 5 + 20)
      }
      for (const name of ['legacy rare', 'mixed rare', 'legacy typo']) {
        expect(medians.get(name)).toBeLessThan(baseline * 10 + 10)
      }
    } finally {
      await harness.close()
    }
  },
  60000
)
