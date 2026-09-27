import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_ID_MAX_LENGTH } from '../../shared/agent-session-wire'
import { CodexPromptRegistry, type CodexPendingPrompt } from './codex-prompt-registry'

function registerPrompt(
  registry: CodexPromptRegistry,
  index: number,
  threadId = 'thread',
  turnId: string | null = 'turn',
  itemId = `item-${index}`
): { itemId: string; prompt: CodexPendingPrompt } {
  const prompt = registry.register({
    id: index,
    method: 'item/commandExecution/requestApproval',
    params: { itemId, threadId, turnId }
  })
  if (!prompt) {
    throw new Error('Fixture prompt was refused')
  }
  const journalItemId = `journal:${threadId}:${itemId}`
  registry.bindJournalItemId(journalItemId, threadId, itemId, turnId)
  return { itemId: journalItemId, prompt }
}

function claimPrompt(
  registry: CodexPromptRegistry,
  index: number,
  turnId = 'turn',
  itemId?: string
): WeakRef<CodexPendingPrompt> {
  const registered = registerPrompt(registry, index, 'thread', null, itemId)
  registry.bindJournalItemId(registered.itemId, 'thread', registered.prompt.promptKey, turnId)
  if (!registry.claimBound(registered.itemId)) {
    throw new Error('Fixture prompt could not be claimed')
  }
  return new WeakRef(registered.prompt)
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function evictLookupEntries(registry: CodexPromptRegistry): void {
  for (let index = 0; index < 256; index += 1) {
    registerPrompt(registry, index + 1_000, 'other-thread', 'other-turn')
  }
}

describe('Codex prompt claim lifetime', () => {
  it('releases 32 evicted claims only when their exact turn completes', async () => {
    const registry = new CodexPromptRegistry()
    const prompts = Array.from({ length: 32 }, (_, index) => claimPrompt(registry, index))
    evictLookupEntries(registry)
    expect(registry.sizes).toEqual({ prompts: 128, journalBindings: 256 })
    expect(registry.find('journal:thread:item-0')).toBeNull()
    registry.clearTurn('other-thread', 'turn')
    registry.clearTurn('thread', 'other-turn')
    await collect()
    expect(prompts.filter((prompt) => prompt.deref() !== undefined)).toHaveLength(32)

    registry.clearTurn('thread', 'turn')
    await collect()
    expect(prompts.filter((prompt) => prompt.deref() !== undefined)).toHaveLength(0)
    expect(registry.sizes).toEqual({ prompts: 128, journalBindings: 256 })
    registry.clear()
  })

  it('preserves a replacement prompt and its active claim when the old turn completes', async () => {
    const registry = new CodexPromptRegistry()
    const old = claimPrompt(registry, 1, 'old-turn', 'same-item')
    const replacement = registerPrompt(registry, 2, 'thread', 'new-turn', 'same-item')
    const claim = registry.claimBound(replacement.itemId)
    if (!claim) {
      throw new Error('Replacement prompt could not be claimed')
    }
    registry.clearTurn('thread', 'old-turn')
    await collect()
    expect(old.deref()).toBeUndefined()
    expect(registry.find(replacement.itemId)).toBe(replacement.prompt)
    expect(registry.ownsBoundClaim(claim, replacement.itemId, 'thread', 'new-turn')).toBe(true)
    registry.clearTurn('thread', 'new-turn')
    expect(registry.ownsClaim(claim)).toBe(false)
  })

  it('finds an evicted claim through its bounded turn digest', async () => {
    const registry = new CodexPromptRegistry()
    const turnId = 'x'.repeat(AGENT_SESSION_ID_MAX_LENGTH + 1)
    const prompt = claimPrompt(registry, 1, turnId)
    evictLookupEntries(registry)
    registry.clearTurn('thread', turnId)
    await collect()
    expect(prompt.deref()).toBeUndefined()
    registry.clear()
  })

  it('releases evicted claims when the session is cleared', async () => {
    const registry = new CodexPromptRegistry()
    const prompt = claimPrompt(registry, 1)
    evictLookupEntries(registry)
    registry.clear()
    await collect()
    expect(prompt.deref()).toBeUndefined()
  })
})
