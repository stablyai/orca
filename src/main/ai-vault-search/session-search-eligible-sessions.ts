import type SyncDatabase from '../sqlite/sync-database'
import type { AiVaultSearchEligibleSessions } from '../../shared/ai-vault-search-eligible-sessions'
import { normalizeSessionPrompt } from '../../shared/ai-vault-session-prompt-match'

type PromptNode = {
  children: Map<string, PromptNode>
  exact: number | undefined
  descendant: number | undefined
}

function mergeTarget(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined ? right : right === undefined || left === right ? left : -1
}

function promptNode(): PromptNode {
  return { children: new Map(), exact: undefined, descendant: undefined }
}

const preparations = new WeakMap<
  SyncDatabase,
  (eligible: AiVaultSearchEligibleSessions | undefined) => void
>()

/** Prepare once per request; SQL passes only each matched session's identity. */
export function registerSessionSearchPromptEligibility(
  db: SyncDatabase
): (eligible: AiVaultSearchEligibleSessions | undefined) => void {
  const existing = preparations.get(db)
  if (existing) {
    return existing
  }
  let previous: AiVaultSearchEligibleSessions['prompts'] | undefined
  let byAgent = new Map<string, PromptNode>()
  const prepare = (eligible: AiVaultSearchEligibleSessions | undefined): void => {
    if (previous === eligible?.prompts) {
      return
    }
    previous = eligible?.prompts
    byAgent = new Map()
    for (const [target, entry] of (eligible?.prompts ?? []).entries()) {
      const root = byAgent.get(entry.agent) ?? promptNode()
      byAgent.set(entry.agent, root)
      for (const candidate of entry.prompts) {
        const prompt = normalizeSessionPrompt(candidate)
        if (!prompt) {
          continue
        }
        let node = root
        for (const character of prompt) {
          let child = node.children.get(character)
          if (!child) {
            child = promptNode()
            node.children.set(character, child)
          }
          node = child
          node.descendant = mergeTarget(node.descendant, target)
        }
        node.exact = mergeTarget(node.exact, target)
      }
    }
  }
  db.function('orca_session_prompt_eligible', (agent, title) => {
    if (typeof agent !== 'string' || typeof title !== 'string') {
      return 0
    }
    const prompt = normalizeSessionPrompt(title)
    let node = byAgent.get(agent)
    let target: number | undefined
    let length = 0
    for (const character of prompt) {
      node = node?.children.get(character)
      if (!node) {
        return target !== undefined && target !== -1 ? 1 : 0
      }
      length += character.length
      if (length >= 24) {
        target = mergeTarget(target, node.exact)
      }
      if (target === -1) {
        return 0
      }
    }
    target = mergeTarget(target, prompt.length >= 24 ? node?.descendant : node?.exact)
    return target !== undefined && target !== -1 ? 1 : 0
  })
  preparations.set(db, prepare)
  return prepare
}
