import type { useTranslate } from '@/i18n/use-translate'

type Translate = ReturnType<typeof useTranslate>

/** "3 changes · latest: Warmer · by Claude · my-app · 2 issues auto-fixed", or null before any. */
export function themeStudioDraftDetail(
  last: { label?: string; by?: string; autoFixed?: number } | undefined,
  changes: number | undefined,
  t: Translate
): string | null {
  const parts = [
    changes && last?.label
      ? t('auto.app-shell.themeStudio.changesLatest', '{{count}} changes · latest: {{label}}', {
          count: changes,
          label: last.label
        })
      : (last?.label ?? null),
    last?.by ? t('auto.app-shell.themeStudio.by', 'by {{by}}', { by: last.by }) : null,
    last?.autoFixed
      ? t('auto.app-shell.themeStudio.autoFixed', '{{count}} issues auto-fixed', {
          count: last.autoFixed
        })
      : null
  ].filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' · ') : null
}
