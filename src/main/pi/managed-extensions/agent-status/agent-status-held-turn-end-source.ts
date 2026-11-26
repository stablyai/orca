import type { PiAgentKind } from '../../../../shared/agent-launch/catalog/pi-agent-kind'

/** Announce a user prompt's reply while only subagents started before that prompt hold the run. */
export function getPiHeldTurnEndHandlerSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    // Why: result delivery wakes the lead with a custom message; older Pi fires before_agent_start only for prompts.
    '  let piUserTurnPending = false',
    '  let piUserTurnPriorChildren: ReadonlySet<string> | null = null',
    '  let heldTurnEndPostedGeneration = -1',
    '',
    '  function rememberUserTurnPriorChildren(): void {',
    '    piUserTurnPriorChildren = piUserTurnPending ? new Set(lifecycleState.active) : null',
    '    piUserTurnPending = false',
    '  }',
    '',
    // A turn that launched a child is woken by its result, so it waits for the all-clear even after that child ends.
    '  function forgetUserTurnOnNewChild(id: string): void {',
    '    if (!piUserTurnPriorChildren?.has(id)) piUserTurnPriorChildren = null',
    '  }',
    '',
    // Wake turns and turns that launched their own children stay held until the all-clear, which reuses this stamp.
    '  function postHeldTurnEnd(): void {',
    '    if (replyFinishedAt === undefined || replyAborted || !piUserTurnPriorChildren || isTurnInFlight()) return',
    '    if (heldTurnEndPostedGeneration === lifecycleState.endedRunGeneration) return',
    '    for (const id of lifecycleState.active) {',
    '      if (!piUserTurnPriorChildren.has(id)) return',
    '    }',
    '    heldTurnEndPostedGeneration = lifecycleState.endedRunGeneration',
    "    post('held_turn_end', { turn_completed_at: replyFinishedAt })",
    '  }',
    ''
  ]
}
