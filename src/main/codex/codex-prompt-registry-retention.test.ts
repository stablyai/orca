import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { codexPromptIdentity } from './codex-structured-prompt-items'
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
  const journalItemId = agentJournalItemKey(codexPromptIdentity({ threadId, promptKey: itemId }))
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

describe('Codex prompt claim lifetime', () => {
  it('retains live claims under pressure and releases only the exact ended turn', async () => {
    const registry = new CodexPromptRegistry()
    const prompts = Array.from({ length: 32 }, (_, index) => claimPrompt(registry, index))
    for (let index = 32; index < 128; index++) {
      registerPrompt(registry, index, 'other-thread', 'other-turn')
    }
    expect(
      registry.register({
        id: 999,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'excess', threadId: 'other-thread' }
      })
    ).toBeNull()
    expect(registry.sizes).toEqual({ prompts: 128, journalBindings: 128 })
    registry.clearTurn('thread', 'other-turn')
    await collect()
    expect(prompts.filter((prompt) => prompt.deref() !== undefined)).toHaveLength(32)
    registry.clearTurn('thread', 'turn')
    await collect()
    expect(prompts.filter((prompt) => prompt.deref() !== undefined)).toHaveLength(0)
    expect(registry.sizes).toEqual({ prompts: 96, journalBindings: 96 })
    registry.clear()
  })

  it('refuses replacing an unresolved claimed address, then admits after the old turn ends', async () => {
    const registry = new CodexPromptRegistry()
    const old = claimPrompt(registry, 1, 'old-turn', 'same-item')
    const request = {
      id: 2,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'same-item', threadId: 'thread', turnId: 'new-turn' }
    }
    expect(registry.register(request)).toBeNull()
    registry.clearTurn('thread', 'old-turn')
    await collect()
    expect(old.deref()).toBeUndefined()
    expect(registry.register(request)).not.toBeNull()
    registry.clear()
  })

  it('finds a retained claim through its bounded turn digest and clears session claims', async () => {
    const registry = new CodexPromptRegistry()
    const turnId = 'x'.repeat(AGENT_SESSION_ID_MAX_LENGTH + 1)
    const prompt = claimPrompt(registry, 1, turnId)
    registry.clearTurn('thread', turnId)
    await collect()
    expect(prompt.deref()).toBeUndefined()
    const next = claimPrompt(registry, 2)
    registry.clear()
    await collect()
    expect(next.deref()).toBeUndefined()
    expect(registry.sizes).toEqual({ prompts: 0, journalBindings: 0 })
  })
})

describe('Codex abandoned command approvals', () => {
  it("reports only a command's own approval that its turn ended unanswered, once", () => {
    const registry = new CodexPromptRegistry()
    const ask = (id: number, method: string, params: Record<string, string>) =>
      registry.register({ id, method, params: { threadId: 'thread', turnId: 'turn', ...params } })
    ask(1, 'item/commandExecution/requestApproval', { itemId: 'unanswered' })
    const answered = ask(2, 'item/commandExecution/requestApproval', { itemId: 'answered' })
    ask(3, 'item/commandExecution/requestApproval', { itemId: 'parent', approvalId: 'sub' })
    ask(4, 'item/fileChange/requestApproval', { itemId: 'patch' })
    if (!answered) {
      throw new Error('Fixture prompt was refused')
    }
    registry.forget(answered)
    registry.clearTurn('thread', 'turn')
    expect(registry.takeAbandonedCommands()).toEqual([{ threadId: 'thread', itemId: 'unanswered' }])
    expect(registry.takeAbandonedCommands()).toEqual([])
  })
})
