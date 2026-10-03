import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('provider-1', 'leaf-1')
}

/** A frame as Claude Code 2.1.280 sends it: a transcript note at a render level. */
function informational(
  level: 'info' | 'notice' | 'suggestion' | 'warning',
  content: string
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'informational',
    content,
    level,
    uuid: `5d3c1f0e-7a2b-4c6d-9e8f-00000000000${level.length}`,
    session_id: 'provider-1'
  }
}

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-informational-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function itemsFor(frames: Record<string, unknown>[]) {
  const journal = await openAgentSessionJournal({
    identity: IDENTITY,
    database: openTestJournalHostDatabase(root),
    now: () => 1_700_000_000_000,
    mintEpoch: () => 'epoch-1'
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: vi.fn() })
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: '1' })
  for (const frame of frames) {
    translator.handle({ type: 'message', sessionId: 'orca-session', message: frame })
    await deferred.drained()
  }
  return journal.snapshot().items.map((item) => item.body)
}

describe('a Claude informational frame', () => {
  it.each(['info', 'notice', 'suggestion'] as const)('writes no row at level %s', async (level) => {
    expect(await itemsFor([informational(level, `A ${level} note`)])).toEqual([])
  })

  it('writes its own words as one warning row at level warning', async () => {
    const content =
      'UserPromptSubmit operation blocked by hook: secrets are not allowed\n\nOriginal prompt: deploy it'
    const items = await itemsFor([informational('warning', content)])

    expect(items).toEqual([{ kind: 'status', tone: 'warning', text: content }])
  })

  it('writes no row for a warning with nothing to say', async () => {
    expect(await itemsFor([informational('warning', '  ')])).toEqual([])
  })
})
