import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredChatNamingDeps } from './structured-chat-naming'

export async function runStructuredChatNameGeneration(input: {
  automatic: boolean
  getRecord: () => AgentSessionRecord | null | undefined
  applicable: () => boolean
  generate: (
    stillCurrent: () => boolean,
    automaticTitle?: Parameters<StructuredChatNamingDeps['generate']>[3]
  ) => Promise<{ name: string; shouldApply?: () => boolean } | null>
  setName: (
    name: string,
    applicable: (record: AgentSessionRecord) => boolean
  ) => Promise<AgentSessionRecord | null>
}): Promise<void> {
  let owner: ((record: AgentSessionRecord) => boolean) | undefined
  const stillCurrent = (latest?: AgentSessionRecord) => {
    const record = latest ?? input.getRecord()
    return input.applicable() && !!record && (owner?.(record) ?? true)
  }
  if (!stillCurrent()) {
    return
  }
  const name = await input.generate(
    stillCurrent,
    input.automatic
      ? {
          retainOwnership: (check) => {
            owner = check
          }
        }
      : undefined
  )
  if (!name || !stillCurrent()) {
    return
  }
  const named = await input.setName(
    name.name,
    (current) => stillCurrent(current) && (name.shouldApply?.() ?? true)
  )
  // A queued write can lose its naming settings while retaining its live session owner.
  if (!named && name.shouldApply && !name.shouldApply() && stillCurrent()) {
    const fallback = await input.generate(stillCurrent)
    if (fallback && stillCurrent()) {
      await input.setName(fallback.name, stillCurrent)
    }
  }
}
