import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredChatNamingDeps } from './structured-chat-naming'

export async function runStructuredChatNameGeneration(input: {
  automaticTitle?: Parameters<StructuredChatNamingDeps['generate']>[3]
  getRecord: () => AgentSessionRecord | null | undefined
  applicable: (current?: AgentSessionRecord) => boolean
  generate: (
    stillCurrent: () => boolean,
    automaticTitle?: Parameters<StructuredChatNamingDeps['generate']>[3]
  ) => Promise<{ name: string; shouldApply?: (record?: AgentSessionRecord) => boolean } | null>
  setName: (
    name: string,
    applicable: (record: AgentSessionRecord) => boolean
  ) => Promise<AgentSessionRecord | null>
}): Promise<void> {
  let owner: ((record: AgentSessionRecord) => boolean) | undefined
  const stillCurrent = (latest?: AgentSessionRecord) => {
    const record = latest ?? input.getRecord()
    return !!record && input.applicable(record) && (owner?.(record) ?? true)
  }
  if (!stillCurrent()) {
    return
  }
  const name = await input.generate(
    stillCurrent,
    input.automaticTitle
      ? {
          ...input.automaticTitle,
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
    (current) => stillCurrent(current) && (name.shouldApply?.(current) ?? true)
  )
  // Independent fallback retains the canonical name/context owner; only timeout retains live ownership.
  if (!named && name.shouldApply && stillCurrent()) {
    const fallback = await input.generate(stillCurrent)
    if (fallback && stillCurrent()) {
      await input.setName(fallback.name, stillCurrent)
    }
  }
}
