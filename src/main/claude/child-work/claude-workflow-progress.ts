import { claudeRecord } from '../structured/journal/claude-structured-item-translation'

type WorkflowAgent = { phaseIndex?: number; state: unknown }

/** One line for a Workflow task's `workflow_progress` snapshot, e.g. `Phase 2/3 · Verify · 4/10 agents done`.
 *  Claude sends the full snapshot or omits it, so an absent field means "unchanged". */
export function claudeWorkflowProgressText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const phases = new Map<number, string>()
  const agents: WorkflowAgent[] = []
  for (const item of value) {
    const row = claudeRecord(item)
    if (row?.type === 'workflow_phase' && typeof row.index === 'number') {
      phases.set(row.index, typeof row.title === 'string' ? row.title : '')
    } else if (row?.type === 'workflow_agent') {
      const phaseIndex = typeof row.phaseIndex === 'number' ? row.phaseIndex : undefined
      if (phaseIndex !== undefined && !phases.has(phaseIndex)) {
        phases.set(phaseIndex, typeof row.phaseTitle === 'string' ? row.phaseTitle : '')
      }
      agents.push({ phaseIndex, state: row.state })
    }
  }
  if (phases.size === 0 && agents.length === 0) {
    return undefined
  }
  const order = [...phases.keys()].sort((left, right) => left - right)
  const running = agents.filter((agent) => agent.state === 'start' || agent.state === 'progress')
  // The latest phase with running agents, else the latest phase any agent reached.
  const current = (running.length > 0 ? running : agents).reduce<number | undefined>(
    (latest, agent) =>
      agent.phaseIndex === undefined || (latest !== undefined && latest >= agent.phaseIndex)
        ? latest
        : agent.phaseIndex,
    undefined
  )
  const inPhase =
    current === undefined ? agents : agents.filter((agent) => agent.phaseIndex === current)
  const done = inPhase.filter((agent) => agent.state === 'done').length
  const failed = inPhase.filter((agent) => agent.state === 'error').length
  const parts: string[] = []
  if (current !== undefined) {
    parts.push(`Phase ${order.indexOf(current) + 1}/${order.length}`)
    const title = phases.get(current)
    if (title) {
      parts.push(title)
    }
  } else if (order.length > 0) {
    parts.push(`${order.length} phases`)
  }
  if (inPhase.length > 0) {
    parts.push(`${done}/${inPhase.length} agents done${failed > 0 ? `, ${failed} failed` : ''}`)
  }
  return parts.join(' · ')
}
