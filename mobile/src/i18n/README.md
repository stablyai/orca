# Mobile localization catalogs

`locales/en.json` and the target-locale JSON files are temporary runtime inputs
until the canonical mobile PO source and read-only compiler land. They are a
bridge, not a second translation source or an invitation to regenerate whole
catalogs.

Feature changes update English only. Target catalogs may be sparse; missing
entries intentionally fall back to current English at runtime. Localization
work may update individual target entries, but must not copy English across a
locale to simulate coverage.

`../../locales/*.json` remains the separate Expo/native metadata projection.
Native permission prompts render before JavaScript, so the future compiler must
produce both the i18next runtime bundle and the Expo/native resources from the
same canonical source.
