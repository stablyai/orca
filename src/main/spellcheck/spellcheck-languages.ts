import type { Session } from 'electron'
import { MAX_SPELLCHECK_LANGUAGES } from '../../shared/settings/spellcheck-languages'

export { MAX_SPELLCHECK_LANGUAGES }

export type SpellcheckSession = Pick<
  Session,
  'availableSpellCheckerLanguages' | 'getSpellCheckerLanguages' | 'setSpellCheckerLanguages'
>

type SpellcheckSettings = {
  spellcheckLanguages?: readonly string[]
}

type SpellcheckSettingsSource = {
  getSettings(): SpellcheckSettings
  onSettingsChanged(
    listener: (
      updates: { spellcheckLanguages?: readonly string[] },
      settings: SpellcheckSettings
    ) => void
  ): () => void
}

/** Trims, drops non-strings and duplicates, and caps the list; invalid input reads as "system default". */
export function normalizeSpellcheckLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const languages: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const code = entry.trim()
    if (!code || seen.has(code)) {
      continue
    }
    seen.add(code)
    languages.push(code)
    if (languages.length === MAX_SPELLCHECK_LANGUAGES) {
      break
    }
  }
  return languages
}

function dedupeCodes(codes: readonly string[]): string[] {
  return [...new Set(codes)]
}

function sameCodes(current: readonly string[], next: readonly string[]): boolean {
  return current.length === next.length && current.every((code, index) => code === next[index])
}

/**
 * Applies the stored languages to a session. An empty or fully unsupported selection falls back to
 * the languages the session started with, so clearing the setting really restores the system default.
 */
export function applySpellcheckLanguages(
  session: SpellcheckSession,
  languages: readonly string[] | undefined,
  systemLanguages: readonly string[] = session.getSpellCheckerLanguages(),
  platform: NodeJS.Platform = process.platform
): string[] {
  // Electron documents this API as a no-op on macOS, where the OS picks the language itself.
  if (platform === 'darwin') {
    return [...systemLanguages]
  }
  const available = new Set(session.availableSpellCheckerLanguages)
  const requested = dedupeCodes(languages?.length ? languages : systemLanguages).filter((code) =>
    available.has(code)
  )
  const fallback = dedupeCodes(systemLanguages).filter((code) => available.has(code))
  const next = requested.length > 0 ? requested : fallback
  if (next.length === 0 || sameCodes(session.getSpellCheckerLanguages(), next)) {
    return next
  }
  session.setSpellCheckerLanguages(next)
  return next
}

/** Applies the setting once at startup and again whenever it changes; unrelated updates are ignored. */
export function followSpellcheckLanguages(
  settingsSource: SpellcheckSettingsSource,
  session: SpellcheckSession,
  platform: NodeJS.Platform = process.platform
): () => void {
  if (platform === 'darwin') {
    return () => {}
  }
  const systemLanguages = session.getSpellCheckerLanguages()
  const apply = (settings: SpellcheckSettings): void => {
    applySpellcheckLanguages(session, settings.spellcheckLanguages, systemLanguages, platform)
  }
  apply(settingsSource.getSettings())
  return settingsSource.onSettingsChanged((updates, settings) => {
    if ('spellcheckLanguages' in updates) {
      apply(settings)
    }
  })
}
