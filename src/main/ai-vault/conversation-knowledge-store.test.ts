import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationKnowledgeStore } from './conversation-knowledge-store'
import type { ConversationKnowledgeItem } from '../../shared/conversation-knowledge-items'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('ConversationKnowledgeStore', () => {
  it('persists generated knowledge and reloads it across instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-knowledge-'))
    temporaryDirectories.push(directory)
    const item = knowledgeItem()

    await new ConversationKnowledgeStore(directory).upsert(item)

    await expect(new ConversationKnowledgeStore(directory).list()).resolves.toEqual([item])
  })

  it('replaces an existing item for the same source session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-knowledge-'))
    temporaryDirectories.push(directory)
    const store = new ConversationKnowledgeStore(directory)
    await store.upsert(knowledgeItem())

    await store.upsert({
      ...knowledgeItem(),
      knowledge: { ...knowledgeItem().knowledge, summary: 'Updated summary' }
    })

    const items = await store.list()
    expect(items).toHaveLength(1)
    expect(items[0]?.knowledge.summary).toBe('Updated summary')
  })

  it('removes cached knowledge for specified source sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-knowledge-'))
    temporaryDirectories.push(directory)
    const store = new ConversationKnowledgeStore(directory)
    const retained = { ...knowledgeItem(), id: 'local:codex:session-2' }
    await store.upsert(knowledgeItem())
    await store.upsert(retained)

    await store.remove(['local:codex:session-1'])

    await expect(store.list()).resolves.toEqual([retained])
  })
})

function knowledgeItem(): ConversationKnowledgeItem {
  return {
    id: 'local:codex:session-1',
    source: {
      executionHostId: 'local',
      agent: 'codex',
      sessionId: 'session-1',
      title: 'SSH lifecycle',
      cwd: '/code/orca',
      updatedAt: '2026-09-01T10:00:00.000Z'
    },
    knowledge: {
      summary: 'Treat lost contact as unverifiable.',
      topics: ['SSH'],
      conclusions: ['Do not infer process exit.'],
      entities: ['Orca']
    },
    generator: {
      agent: 'codex',
      model: 'gpt-5',
      generatedAt: '2026-09-01T10:01:00.000Z'
    }
  }
}
