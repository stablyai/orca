import type { Translate } from '../../i18n/mobile-i18n'

// Deep links may provide only a repo::path id; derive a readable label from it.
export function getWorktreeLabel(
  name: string | undefined,
  worktreeId: string,
  t: Translate
): string {
  if (name?.trim()) {
    return name.trim()
  }
  const pathPart = worktreeId.includes('::')
    ? worktreeId.slice(worktreeId.indexOf('::') + 2)
    : worktreeId
  const normalized = pathPart.replace(/\\/g, '/').replace(/\/+$/, '')
  return (
    normalized.slice(normalized.lastIndexOf('/') + 1) ||
    t('session.worktreeLabel.fallback', 'Worktree')
  )
}
