// The models a session's options answer lists, the same whether a child answers live or the host
// answers for a chat at rest: the catalog's rows, plus the current model when the catalog does not
// list it. Nothing says which efforts an unlisted model takes, so its row offers none, and a client
// shows no effort control for it.

import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'

/** `row` builds a provider's own row type from the shared one. */
export function structuredAgentSessionOptionModels<TModel extends AgentSessionModelOption>(
  catalog: readonly TModel[],
  current: string | undefined,
  row: (unlisted: AgentSessionModelOption) => TModel
): TModel[] {
  const models = [...catalog]
  if (current && !models.some((entry) => entry.id === current)) {
    models.push(row({ id: current, label: current, isDefault: false, efforts: [] }))
  }
  return models
}
