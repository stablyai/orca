import { useCallback, useState } from 'react'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function getBaseResolveError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : translate('tasks.composerSource.baseFailed', 'Failed to resolve base branch.')
}

export function useForkPushWarning() {
  const t = useMobileTranslation()
  const [hasWarning, setHasWarning] = useState(false)
  const setForkPushWarning = useCallback((warning: string | null) => {
    setHasWarning(warning !== null)
  }, [])

  return [
    hasWarning
      ? t(
          'tasks.composerSource.forkPushWarning',
          'This PR has "Allow edits from maintainers" off; pushing to the fork may be rejected by GitHub.'
        )
      : null,
    setForkPushWarning
  ] as const
}
