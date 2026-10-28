export type ProfileStateSectionLabelTranslate = (key: string, englishFallback: string) => string

const englishLabel: ProfileStateSectionLabelTranslate = (_key, englishFallback) => englishFallback

function sectionLabel(domain: string, translate: ProfileStateSectionLabelTranslate): string {
  switch (domain) {
    case 'repos':
    case 'projects':
    case 'projectHostSetups':
      return translate('profileState.section.projects', 'Projects')
    case 'projectGroups':
      return translate('profileState.section.projectGroups', 'Project groups')
    case 'folderWorkspaces':
      return translate('profileState.section.folderWorkspaces', 'Folder workspaces')
    case 'folderWorkspaceDiffComments':
      return translate('profileState.section.reviewComments', 'Review comments')
    case 'worktreeMeta':
    case 'worktreeMetaByIdentity':
    case 'worktreeIdentityAliases':
    case 'worktreeLineageById':
    case 'workspaceLineageByChildKey':
      return translate('profileState.section.workspaceDetails', 'Workspace details')
    case 'settings':
      return translate('profileState.section.settings', 'Settings')
    case 'ui':
      return translate('profileState.section.windowLayout', 'Window layout')
    case 'remoteLayoutSnapshots':
      return translate('profileState.section.openTabs', 'Open tabs and terminals')
    case 'sshTargets':
      return translate('profileState.section.sshHosts', 'SSH hosts')
    case 'automations':
      return translate('profileState.section.automations', 'Automations')
    case 'automationRuns':
      return translate('profileState.section.automationHistory', 'Automation history')
    case 'onboarding':
      return translate('profileState.section.onboarding', 'Onboarding progress')
    default:
      return translate('profileState.section.other', 'Other saved app state')
  }
}

// Losing project lists also loses access to their workspace details.
const PROJECT_LIST_SECTIONS = new Set(['repos', 'projects', 'folderWorkspaces'])

/** English unless a translator is passed; CLI and log text stay English. */
export function profileStateSectionLabels(
  domains: readonly string[],
  translate: ProfileStateSectionLabelTranslate = englishLabel
): string[] {
  return [...new Set(domains.map((domain) => sectionLabel(domain, translate)))]
}

export function includesProjectListSection(domains: readonly string[]): boolean {
  return domains.some((domain) => PROJECT_LIST_SECTIONS.has(domain))
}
