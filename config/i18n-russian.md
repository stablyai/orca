# Russian localization

Russian uses the built-in locale `ru`. System detection recognizes regional and POSIX tags such as `ru-RU`, `ru-KZ` and `ru_RU.UTF-8`. Renderer catalogs and native menu translations load lazily. The selected language also supplies the locale for the existing number, date, relative-time and weekday formatters. Paired web clients keep their language preference locally when a server is older or offline.

The nested i18next catalog lives at `src/renderer/src/i18n/locales/ru.json`. Missing translations use the current English fallback. Standalone React Native mobile screens have separate copy; the shared desktop renderer used by paired web clients uses this catalog. Provider transcripts, approval options, user content and third-party plugin content retain their original language.

## Translation workflow

Keep inline English defaults and `en.json` synchronized with the current source. Run `pnpm run sync:localization-catalog` to add missing literal defaults; review existing stable IDs separately when their English wording changes. Regenerate the English boot subset with `pnpm run sync:localization-runtime-catalog`. Do not copy a catalog snapshot from a branch containing unrelated features.

Generate source-bearing translation tasks in a directory of your choice:

```sh
node config/scripts/russian-translation-progress.mjs --write-missing tmp/russian-translation
```

The inventory separates missing entries, unreviewed English copies, intentional original values, additional CLDR forms and unknown IDs. It refreshes every domain file, including empty ones. Assign disjoint entries for review, return separate delta files, and have one contributor apply them to avoid concurrent catalog rewrites. A reviewed delta has this shape:

```json
{
  "ru": {
    "components.native-chat.composer.send": {
      "source": "Send",
      "translation": "Отправить"
    }
  }
}
```

Apply a reviewed delta and validate it:

```sh
node config/scripts/apply-translation-delta.mjs tmp/russian-translation/reviewed.delta.json
node config/scripts/verify-localization-catalog.mjs
node config/scripts/russian-translation-progress.mjs --require-complete
```

Russian deltas require the exact current English `source`. The importer rejects empty values, changed placeholders, altered literal code or link destinations, lost markup and broken tag nesting. It preserves existing translations unless the delta includes a matching `previousTranslation`. It validates a locale before replacing its file atomically.

Translate complete phrases in context. Preserve product names, command syntax, paths and interpolation variables. Reuse a translation only after checking both the English source and its UI meaning. Native language labels, technical identifiers and interpolation-only values may intentionally match English. Context-specific exemptions in `config/localization-russian-invariants.json` require an exact English source and a review rationale; changing the source invalidates the exemption. Never exempt ordinary untranslated prose.

## Plurals and source grammar

Pass `count` for count-based messages. Russian uses `one`, `few`, `many` and `other`; test zero, singular, small plurals, teens, compound counts and fractions. The validator permits additional locale-specific forms only for an existing English `_other` family and valid CLDR categories, and checks their placeholders against that source.

Prefer a whole sentence over translated fragments or JavaScript singular/plural concatenation. Where changing legacy behavior is unnecessary, a reviewed count-neutral phrase can preserve grammar. Keep original provider content separate from application labels.

## Verification

Run these independent catalog checks after editing source copy or translations:

```sh
pnpm run verify:localization-catalogs
pnpm run verify:localization-extraction
pnpm run verify:localization-coverage
node config/scripts/russian-translation-progress.mjs --require-complete
```

Completeness measures coverage of the current English catalog; it does not prove linguistic quality or rendered behavior. Locale tests cover detection, lazy loaders, CLDR selection, formatting, live language changes, guarded imports and paired-client preferences. Source grammar tests cover whole messages and their count families. The future PO authoring migration is described in [the translation-source decision](./i18n-translation-source.md).

For rendered validation, use the repository's Playwright/Electron harness with `ORCA_BACKGROUND_LAUNCH=1` and an isolated profile. Build current E2E assets before running `tests/e2e/russian-conversation-locale.spec.ts`; use `SKIP_BUILD=1` only while those assets remain current. Keep windows hidden and drive the renderer through CDP. The spec checks the Appearance language picker, persisted preference, original provider transcript and editable Russian composer.
