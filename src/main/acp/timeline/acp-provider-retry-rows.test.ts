import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import { openAcpFixtureRig, readAcpFixture } from './testing/acp-timeline-fixture.test-support'

describe('ACP provider retries', () => {
  it('shows agy empty-output retries as one retrying row, not reply text', async () => {
    const fixture = await openAcpFixtureRig(ANTIGRAVITY_ACP_DIALECT)
    const rows = await fixture.feed(await readAcpFixture('antigravity-v1.5.9-empty-output-retries'))
    expect(
      rows.flatMap((row): unknown[] =>
        row.body.kind === 'status' && row.body.failure
          ? [{ [row.body.failure.kind]: row.body.failure.retry }]
          : row.body.kind === 'message' && row.body.role === 'assistant'
            ? [{ reply: row.body.blocks.map((block) => block.type === 'text' && block.text) }]
            : []
      )
    ).toEqual([
      { providerRetrying: { cause: 'Model produced invalid output.', attempt: 2 } },
      { reply: ['Hello from fake model.'] }
    ])
  })
})
