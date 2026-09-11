# Mobile localization

`mobile-i18n.ts` wires an i18next instance to the device locale reported by
`expo-localization`. `locales/en.json` is currently empty: this is the wiring,
landed without string extraction so the two can be reviewed separately.

## Catalogs

Feature changes update English only. Target catalogs may be sparse; missing
entries intentionally fall back to English at runtime. Localization work may
update individual target entries, but must not copy English across a locale to
simulate coverage.

Only the fallback and the active locale are registered at startup. A locale
change restarts the app, so exactly one non-fallback catalog is ever live per
run — register the rest and every cold boot parses catalogs nothing will read.
Add new catalogs to `MOBILE_LOCALE_CATALOGS` as thunks so this stays true.

## `src/shared/` must stay string-free

Modules under `src/shared/` are imported by the desktop renderer as well as
mobile, so a mobile-only `translate()` cannot live there. Do not inject a
translator either: it makes pure functions impure, forces every caller and test
to supply one, and means shared output depends on which platform called it.

Instead, shared modules return structured data — a unit and a count, a key and
its parameters — and each platform formats at its own UI edge. Relative time is
the clearest case: plural rules and word order differ per language, and i18next
needs the count as a number at the render site, which a pre-baked string cannot
give it. `src/shared/pr-comment-time.ts` is the module this applies to today.

## Native metadata is a separate projection

`app.json`'s Expo `locales` map and iOS `CFBundleAllowMixedLocalizations` are
not wired yet. Native permission prompts render before JavaScript, so they are
produced from the same canonical source but through a different channel. Until
they land, iOS may not report a non-English device locale to this code.
