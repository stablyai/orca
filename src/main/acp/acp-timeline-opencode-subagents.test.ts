import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { openAcpFixtureRig, readAcpFixture } from './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

function rowsByProducer(rows: AgentJournalRenderItem[]) {
  return rows.flatMap((row) =>
    row.body.kind === 'tool-call'
      ? [[row.agentId ?? 'main', 'tool', row.body.name, row.body.state]]
      : row.body.kind === 'message' && row.body.role === 'assistant'
        ? [[row.agentId ?? 'main', 'text']]
        : []
  )
}

describe('OpenCode 2 subagents through the shared timeline', () => {
  it('a finished subagent is one record, and its own tools and reply sit under it', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    const rows = await fixture.feed(await readAcpFixture('opencode-v2-subagent'))
    expect(
      fixture.subagents().map((view) => [view.providerId, view.description, view.outcome])
    ).toEqual([['session-2', 'Create child.txt file', 'succeeded']])
    expect(rowsByProducer(rows)).toEqual([
      ['main', 'tool', 'subagent', 'completed'],
      ['session-2', 'tool', 'write', 'completed'],
      ['session-2', 'text'],
      ['main', 'text']
    ])
    expect((await fixture.rig.turns()).map((turn) => turn.outcome)).toEqual(['success'])
  })

  it('Stop while a subagent runs ends it as stopped', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT)
    await fixture.feed(await readAcpFixture('opencode-v2-subagent-stop'))
    expect(fixture.subagents().map((view) => [view.providerId, view.outcome])).toEqual([
      ['session-2', 'cancelled']
    ])
  })
})
