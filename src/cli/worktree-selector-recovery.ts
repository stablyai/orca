import { RuntimeClientError } from './runtime/types'
import { attachCliErrorData } from './handlers/worktree-setup-decision-recovery'

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

export async function withWorktreeSelectorRecovery<T>(
  pending: Promise<T>,
  nextSteps: readonly string[],
  selector?: string
): Promise<T> {
  try {
    return await pending
  } catch (error) {
    if (
      !nextSteps.length ||
      !(error instanceof RuntimeClientError) ||
      error.code !== 'selector_not_found'
    ) {
      throw error
    }
    const data = error.data && typeof error.data === 'object' ? error.data : {}
    const previousSteps =
      'nextSteps' in data && Array.isArray(data.nextSteps)
        ? data.nextSteps.filter((step: unknown): step is string => typeof step === 'string')
        : []
    throw attachCliErrorData(error, {
      ...data,
      ...(selector ? { selector } : {}),
      validSelectorForms: WORKTREE_SELECTOR_FORMS,
      nextSteps: [...nextSteps, ...previousSteps]
    })
  }
}

export const parentCwdNextSteps = (selector?: string): string[] => [
  `The parent selector "${selector}" could not be resolved. Run from an Orca-managed worktree or pass an explicit parent selector.`
]
