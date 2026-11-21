// Which reply a bot's Tidy-up asks for: the whole new MEMORY.md, or, for a bot in the ops pilot, ops
// on numbered lines after the status move. Both are applied through the memory record.
import { applyBotMemoryChange } from '../../shared/bot-memory-lines'
import { memorySnapshot } from './bot-memory-ops'
import { type TidyUpChat, type TidyUpMemoryFile, tidyUpPrompt } from './bot-memory-tidy-up'
import { applyTidyUpDraft, applyTidyUpOps } from './bot-memory-tidy-up-apply'
import { tidyUpOpsPrompt } from './bot-memory-tidy-up-ops-prompt'
import { statusMigrationPlan } from './bot-memory-status-migration'

type ApplyDeps = Parameters<typeof applyTidyUpDraft>[0]

export function tidyUpFormat(input: {
  memory: string
  files: readonly TidyUpMemoryFile[]
  chats: readonly TidyUpChat[]
  today: string
  pilot: boolean
  /** Lines the owner kept from salvage, which the status move leaves. */
  kept?: ReadonlySet<string>
}): {
  prompt: string
  apply: (
    deps: ApplyDeps,
    run: { botId: string; folder: string; reply: string }
  ) => ReturnType<typeof applyTidyUpDraft>
} {
  const { memory, files, chats, today } = input
  if (!input.pilot) {
    return {
      prompt: tidyUpPrompt({ memory, files, chats, today }),
      apply: (deps, run) => applyTidyUpDraft(deps, { ...run, memory, today })
    }
  }
  // The status move needs no model: the ops see MEMORY.md as it will be after it.
  const migration = statusMigrationPlan(memory, today, input.kept)
  const shown = migration ? applyBotMemoryChange(memory, migration.change) : memory
  return {
    prompt: tidyUpOpsPrompt({ snapshot: memorySnapshot(shown), files, chats }),
    apply: (deps, run) =>
      applyTidyUpOps(deps, {
        ...run,
        memory: shown,
        today,
        migration
      })
  }
}
