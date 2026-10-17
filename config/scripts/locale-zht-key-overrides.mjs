// Per-key Traditional overrides, by Orca message ID.
//
// Why a key map in addition to the phrase fixes: a value whose correct form
// cannot be expressed as a substring rule, because the same substring must stay
// untouched elsewhere, is pinned here.
import { NATIVE_PICKER_LABELS } from './locale-translation-policy.mjs'

/**
 * The language picker lists every language in its OWN script, so a reader can
 * find their language from an interface they cannot read. Converting them would
 * rename Simplified Chinese "中文（簡體）" in a script its own users do not read —
 * the one place a Simplified form must survive in this catalog.
 *
 * Derived from NATIVE_PICKER_LABELS rather than restated, so the catalog and the
 * repair policy cannot drift into disagreeing about the same labels. Every locale
 * in that table carries identical values (an endonym does not vary by UI locale).
 */
export const ZHT_KEY_OVERRIDES = Object.fromEntries(
  Object.entries(NATIVE_PICKER_LABELS.zh).map(([labelKey, label]) => [
    `settings.appearance.language.${labelKey}`,
    label
  ])
)
