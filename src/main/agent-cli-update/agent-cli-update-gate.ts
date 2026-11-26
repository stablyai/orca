// Checks of an agent's own CLI and updates of it never overlap on this host.

import type { AgentCliUpdateAgent } from '../../shared/agent-launch/installation/agent-cli-update'

type Gate = { checks: Set<Promise<unknown>>; update: Promise<unknown> | null }

// One per supported agent, kept for the process lifetime.
const gates = new Map<AgentCliUpdateAgent, Gate>()

function gateFor(agent: AgentCliUpdateAgent): Gate {
  let gate = gates.get(agent)
  if (!gate) {
    gate = { checks: new Set(), update: null }
    gates.set(agent, gate)
  }
  return gate
}

/** Runs `check` once no update of `agent` is running or waiting. */
export async function checkThroughGate<T>(
  agent: AgentCliUpdateAgent,
  check: () => Promise<T>
): Promise<T> {
  const gate = gateFor(agent)
  while (gate.update) {
    await gate.update.catch(() => undefined)
  }
  const running = check()
  gate.checks.add(running)
  try {
    return await running
  } finally {
    gate.checks.delete(running)
  }
}

/** Runs `update` after the agent's running checks finish, holding new ones until it ends. */
export async function updateThroughGate<T>(
  agent: AgentCliUpdateAgent,
  update: () => Promise<T>
): Promise<T> {
  const gate = gateFor(agent)
  const running = Promise.allSettled(
    gate.update ? [...gate.checks, gate.update] : gate.checks
  ).then(update)
  gate.update = running
  try {
    return await running
  } finally {
    if (gate.update === running) {
      gate.update = null
    }
  }
}
