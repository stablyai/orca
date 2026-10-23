// The runtime omits the typed selector from not-found errors; add it and its grammar at the CLI boundary.

export const WORKTREE_SELECTOR_FORMS = [
  'id:<repo-id>::<absolute-path>',
  'path:<absolute-path>',
  'name:<display-name>',
  'branch:<branch>',
  'identity:<identity-key>',
  'issue:<number>',
  'current',
  'active'
] as const

export type WorktreeSelectorRecovery = {
  selector: string
  validSelectorForms: readonly string[]
  suggestions: readonly string[]
  nextSteps: readonly string[]
}

const PREFIXES = ['id:', 'path:', 'name:', 'branch:', 'identity:', 'issue:']

function suggestForms(selector: string): string[] {
  if (selector.startsWith('id:')) {
    // A worktree id is `<repo-id>::<path>`; the repo id alone names no checkout.
    return selector.includes('::')
      ? []
      : [`id:${selector.slice(3)}::<absolute-path>`, 'path:<absolute-path>']
  }
  if (PREFIXES.some((prefix) => selector.startsWith(prefix))) {
    return []
  }
  return selector.startsWith('/') || /^[A-Za-z]:[\\/]/.test(selector)
    ? [`path:${selector}`]
    : [`id:${selector}::<absolute-path>`, `name:${selector}`, `branch:${selector}`]
}

export function worktreeSelectorRecovery(selector: string): WorktreeSelectorRecovery {
  const suggestions = suggestForms(selector)
  return {
    selector,
    validSelectorForms: WORKTREE_SELECTOR_FORMS,
    suggestions,
    nextSteps: [
      `No Orca workspace matched the worktree selector "${selector}".`,
      ...(suggestions.length > 0 ? [`Did you mean: ${suggestions.join(', ')}`] : []),
      `Valid selector forms: ${WORKTREE_SELECTOR_FORMS.join(', ')}.`,
      'List the exact values with `orca worktree list --json`; a bare repository id is not a worktree id.'
    ]
  }
}
