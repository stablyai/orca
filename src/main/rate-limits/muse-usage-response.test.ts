import { describe, expect, it } from 'vitest'
import { parseMuseUsageStdout } from './muse-usage-response'

// Captured from `muse usage --json` on Muse Code 1.4.14 (1.4.14-R7309.1).
const MUSE_1_4_14_STDOUT =
  '{"schemaVersion":1,"allowance":{"tier":"Muse Code Everyday Usage","window":{"usedPercent":9,"resetsAtMs":1793961242000},"weekly":{"usedPercent":3,"resetsAtMs":1794182400000},"asOfMs":1793948472512,"source":"mint"},"reason":null,"hint":null}\n'

describe('parseMuseUsageStdout', () => {
  it('maps the Muse allowance window and weekly periods', () => {
    expect(parseMuseUsageStdout(MUSE_1_4_14_STDOUT, 1793948500000)).toEqual({
      kind: 'ok',
      limits: {
        provider: 'muse',
        session: {
          usedPercent: 9,
          windowMinutes: 300,
          resetsAt: 1793961242000,
          resetDescription: null
        },
        weekly: {
          usedPercent: 3,
          windowMinutes: 10_080,
          resetsAt: 1794182400000,
          resetDescription: null
        },
        updatedAt: 1793948500000,
        planType: 'Muse Code Everyday Usage',
        error: null,
        status: 'ok',
        usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
      }
    })
  })

  it('reports an API-key login as having no subscription allowance', () => {
    const stdout = '{"schemaVersion":1,"allowance":null,"reason":"api_key","hint":null}'
    expect(parseMuseUsageStdout(stdout, 1)).toMatchObject({
      kind: 'no-allowance',
      failureKind: 'no-subscription'
    })
  })

  it('rejects output that is not the schemaVersion 1 envelope', () => {
    expect(parseMuseUsageStdout('Tier: Muse Code Everyday Usage\n', 1)).toBeNull()
    expect(parseMuseUsageStdout('{"schemaVersion":2,"allowance":null}', 1)).toBeNull()
    expect(
      parseMuseUsageStdout(
        '{"schemaVersion":1,"allowance":{"window":{"usedPercent":"9"},"weekly":null}}',
        1
      )
    ).toBeNull()
  })
})
