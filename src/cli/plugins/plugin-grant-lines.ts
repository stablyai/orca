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
    ...grants.contributions.map((item) => `  adds ${item.kind}: ${item.name}`)
  ]
}
