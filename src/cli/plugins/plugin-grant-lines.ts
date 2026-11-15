/** The displayed part of `PluginApprovalGrants`; also what a host's `approval_required` data carries. */
export type PluginGrantSummary = {
  execution: string
  executionDescription: string
  capabilities: { description: string }[]
  contributions: { kind: string; name: string }[]
}

type GrantSubject = { pluginKey: string; version: string; grants: PluginGrantSummary }

/** What a plugin would be granted, as `orca plugin inspect` and the dev watch prompt print it. */
export function formatPluginGrantLines(subject: GrantSubject): string[] {
  const { grants } = subject
  return [
    `${subject.pluginKey} ${subject.version} (${grants.execution})`,
    `  ${grants.executionDescription}`,
    ...grants.capabilities.map((capability) => `  - ${capability.description}`),
    ...contributionLines(grants.contributions)
  ]
}

/** One line per contribution; same-named ones (a theme's light and dark variants) are counted
 *  on one line instead of repeating. */
function contributionLines(contributions: PluginGrantSummary['contributions']): string[] {
  const counts = new Map<string, { kind: string; name: string; count: number }>()
  for (const { kind, name } of contributions) {
    const key = `${kind}\u0000${name}`
    const entry = counts.get(key)
    if (entry) {
      entry.count += 1
    } else {
      counts.set(key, { kind, name, count: 1 })
    }
  }
  return [...counts.values()].map(
    ({ kind, name, count }) => `  adds ${kind}: ${name}${count > 1 ? ` (${count} variants)` : ''}`
  )
}
