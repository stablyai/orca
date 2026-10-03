// The one way a chat command reaches a chat: host startup's settle first, then the chat's lock.
// The settle takes chats' locks too, so the wait comes before the lock, never under it. Nothing
// that holds a chat's lock calls this; /clear's attach of its replacement, under the source
// chat's lock, is the one call that does, and it can, because its own command already passed the
// wait and the wait never closes again.

import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

type CommandEntryContext = {
  deps: Pick<StructuredAgentSessionHostDeps, 'commandsReady'>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
}

/** Queued on the lock at once when startup is done, so commands keep the order they arrived in. */
export function serializeStructuredAgentSessionCommand<T>(
  context: CommandEntryContext,
  sessionId: string,
  task: () => Promise<T>
): Promise<T> {
  const startup = context.deps.commandsReady?.()
  const run = () => context.serialize(sessionId, task)
  return startup ? startup.then(run) : run()
}
