import type { MrStateFilter, SmartNameMode } from './mobile-composer-source-types'

// Icon each tab renders: lucide glyphs for the neutral modes, the inline brand
// SVGs (TaskProviderLogo) for the provider modes since lucide dropped its brand
// icons.
export type SmartModeIcon =
  | { type: 'lucide'; name: 'sparkles' | 'git-branch' | 'case-sensitive' }
  | { type: 'provider'; provider: 'github' | 'gitlab' | 'linear' }

export type SmartModeOption = {
  id: SmartNameMode
  label: string
  icon: SmartModeIcon
}

// Order + labels + icons mirror desktop getSmartWorkspaceNameModes():
// Smart · GitHub · Linear · GitLab · Branch · Name.
export const SMART_MODE_OPTIONS: readonly SmartModeOption[] = [
  { id: 'smart', label: 'Smart', icon: { type: 'lucide', name: 'sparkles' } },
  { id: 'github', label: 'GitHub', icon: { type: 'provider', provider: 'github' } },
  { id: 'linear', label: 'Linear', icon: { type: 'provider', provider: 'linear' } },
  { id: 'gitlab', label: 'GitLab', icon: { type: 'provider', provider: 'gitlab' } },
  { id: 'branches', label: 'Branch', icon: { type: 'lucide', name: 'git-branch' } },
  { id: 'text', label: 'Name', icon: { type: 'lucide', name: 'case-sensitive' } }
]

export type SmartModeAvailabilityInput = {
  textOnly: boolean
  tasksSupported: boolean
  hasRepo: boolean
  githubAvailable: boolean
  gitlabAvailable: boolean
  linearAvailable: boolean
}

// Faithful port of the desktop availableModes filter. Non-git repos collapse to
// the Name tab; provider tabs gate on availability + a selected repo + the tasks
// RPC surface; branches only need a git repo (new-branch-by-name works without
// the search capability).
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
      case 'branches':
        return input.hasRepo
      case 'text':
        return true
    }
  }).map((option) => option.id)
}

// Default mode when the picker opens: 'smart' for a git repo when search is
// available, else the first available mode (branches for git without tasks,
// 'text' for non-git).
export function resolveDefaultSmartMode(input: SmartModeAvailabilityInput): SmartNameMode {
  const available = resolveAvailableSmartModes(input)
  if (available.includes('smart')) {
    return 'smart'
  }
  return available[0] ?? 'text'
}

// Keeps a chosen mode valid as availability changes (e.g. the repo switches to a
// non-git folder), mirroring desktop's snap-to-available effect.
export function normalizeSmartMode(
  mode: SmartNameMode,
  input: SmartModeAvailabilityInput
): SmartNameMode {
  const available = resolveAvailableSmartModes(input)
  return available.includes(mode) ? mode : resolveDefaultSmartMode(input)
}

export type MrStateFilterOption = { id: MrStateFilter; label: string }

// Desktop getMrStateFilters(): Open · Merged · Closed · All, default 'opened'.
export const MR_STATE_FILTER_OPTIONS: readonly MrStateFilterOption[] = [
  { id: 'opened', label: 'Open' },
  { id: 'merged', label: 'Merged' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' }
]

export const DEFAULT_MR_STATE_FILTER: MrStateFilter = 'opened'
