import type { MrStateFilter } from './mobile-composer-source-types'
import type { SmartNameMode } from '../../../../src/shared/new-workspace/smart-workspace-source-results'
import type { Translate } from '../../i18n/mobile-i18n'

// Lucide has no brand icons; provider modes use TaskProviderLogo SVGs.
export type SmartModeIcon =
  | { type: 'lucide'; name: 'sparkles' | 'git-branch' | 'case-sensitive' }
  | { type: 'provider'; provider: 'github' | 'gitlab' | 'linear' | 'jira' }

export type SmartModeOption = {
  id: SmartNameMode
  label: (t: Translate) => string
  icon: SmartModeIcon
}

export const SMART_MODE_OPTIONS: readonly SmartModeOption[] = [
  {
    id: 'smart',
    label: (t) => t('tasks.smartSourceModes.smart', 'Smart'),
    icon: { type: 'lucide', name: 'sparkles' }
  },
  { id: 'github', label: () => 'GitHub', icon: { type: 'provider', provider: 'github' } },
  { id: 'linear', label: () => 'Linear', icon: { type: 'provider', provider: 'linear' } },
  { id: 'jira', label: () => 'Jira', icon: { type: 'provider', provider: 'jira' } },
  { id: 'gitlab', label: () => 'GitLab', icon: { type: 'provider', provider: 'gitlab' } },
  {
    id: 'branches',
    label: (t) => t('tasks.smartSourceModes.branch', 'Branch'),
    icon: { type: 'lucide', name: 'git-branch' }
  },
  {
    id: 'text',
    label: (t) => t('tasks.smartSourceModes.name', 'Name'),
    icon: { type: 'lucide', name: 'case-sensitive' }
  }
]

export type SmartModeAvailabilityInput = {
  textOnly: boolean
  tasksSupported: boolean
  hasRepo: boolean
  githubAvailable: boolean
  gitlabAvailable: boolean
  linearAvailable: boolean
  jiraAvailable: boolean
}

export function resolveAvailableSmartModes(input: SmartModeAvailabilityInput): SmartNameMode[] {
  if (input.textOnly) {
    return ['text']
  }
  return SMART_MODE_OPTIONS.filter((option) => {
    switch (option.id) {
      case 'smart':
        return input.tasksSupported
      case 'github':
        return input.tasksSupported && input.hasRepo && input.githubAvailable
      case 'gitlab':
        return input.tasksSupported && input.hasRepo && input.gitlabAvailable
      case 'linear':
        return input.tasksSupported && input.linearAvailable
      case 'jira':
        // Jira is not repo-scoped; it needs no selected repo.
        return input.tasksSupported && input.jiraAvailable
      case 'branches':
        return input.hasRepo
      case 'text':
        return true
    }
  }).map((option) => option.id)
}

export function resolveDefaultSmartMode(input: SmartModeAvailabilityInput): SmartNameMode {
  const available = resolveAvailableSmartModes(input)
  if (available.includes('smart')) {
    return 'smart'
  }
  return available[0] ?? 'text'
}

export function normalizeSmartMode(
  mode: SmartNameMode,
  input: SmartModeAvailabilityInput
): SmartNameMode {
  const available = resolveAvailableSmartModes(input)
  return available.includes(mode) ? mode : resolveDefaultSmartMode(input)
}

export type MrStateFilterOption = { id: MrStateFilter; label: (t: Translate) => string }

export const MR_STATE_FILTER_OPTIONS: readonly MrStateFilterOption[] = [
  {
    id: 'opened',
    label: (t) => t('tasks.smartSourceModes.openState', 'Open')
  },
  {
    id: 'merged',
    label: (t) => t('tasks.smartSourceModes.mergedState', 'Merged')
  },
  {
    id: 'closed',
    label: (t) => t('tasks.smartSourceModes.closedState', 'Closed')
  },
  {
    id: 'all',
    label: (t) => t('tasks.smartSourceModes.allStates', 'All')
  }
]

export const DEFAULT_MR_STATE_FILTER: MrStateFilter = 'opened'
