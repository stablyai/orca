const SECTION_LABELS: ReadonlyMap<string, string> = new Map([
  ['repos', 'Projects'],
  ['projects', 'Projects'],
  ['projectHostSetups', 'Projects'],
  ['projectGroups', 'Project groups'],
  ['folderWorkspaces', 'Folder workspaces'],
  ['folderWorkspaceDiffComments', 'Review comments'],
  ['worktreeMeta', 'Workspace details'],
  ['worktreeMetaByIdentity', 'Workspace details'],
  ['worktreeIdentityAliases', 'Workspace details'],
  ['worktreeLineageById', 'Workspace details'],
  ['workspaceLineageByChildKey', 'Workspace details'],
  ['settings', 'Settings'],
  ['ui', 'Window layout'],
  ['remoteLayoutSnapshots', 'Open tabs and terminals'],
  ['sshTargets', 'SSH hosts'],
  ['automations', 'Automations'],
  ['automationRuns', 'Automation history'],
  ['onboarding', 'Onboarding progress']
])

// Losing project lists also loses access to their workspace details.
const PROJECT_LIST_SECTIONS = new Set(['repos', 'projects', 'folderWorkspaces'])

export function profileStateSectionLabels(domains: readonly string[]): string[] {
  return [
    ...new Set(domains.map((domain) => SECTION_LABELS.get(domain) ?? 'Other saved app state'))
  ]
}

export function includesProjectListSection(domains: readonly string[]): boolean {
  return domains.some((domain) => PROJECT_LIST_SECTIONS.has(domain))
}
