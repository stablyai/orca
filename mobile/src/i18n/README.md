# i18n (mobile)

User-facing string localization for the Orca mobile app.

## What lives here

- `init.ts` — i18next bootstrap (idempotent; loads desktop's `zh.json` via Metro `watchFolders`)
- `I18nProvider.tsx` — thin wrapper around react-i18next's `<I18nextProvider>`
- `T.tsx` — `<T>` React Native wrapper around `<Text>`. Children-as-fallback pattern: TypeScript enforces a string literal at every `<T>` site, so the English fallback is known at compile time.
- `useT.ts` — hook for non-React-tree translation access (event handlers, async callbacks)

## Test coverage note

The plan called for `<T>` and `useT` unit tests via `@testing-library/react-native`. These are **deliberately skipped** for v1 because this codebase has no React Native component testing infrastructure (no Jest preset, no `react-test-renderer` adapter).

Adding RN component testing is out of scope for the i18n effort. The risk is mitigated by:

1. **Smoke check** — the implementation is verified end-to-end via the manual smoke flow in `docs/superpowers/plans/2026-06-28-mobile-i18n.md` Task 17.
2. **Type safety** — `<T>`'s `TProps` type enforces `children: string`, so wrong-typed usage fails compile.
3. **Library maturity** — `i18next` + `react-i18next` are upstream-tested for `useTranslation` + `languageChanged` behavior.

To add component tests later, set up:

- `@testing-library/react-native` (devDep)
- `vitest.config.ts` include glob update to `.tsx`
- A mock for `react-native` that strips the CJS Flow syntax in `react-native/index.js` (e.g., via `@react-native/babel-preset`).

## Translation source

This module shares `src/renderer/src/i18n/locales/zh.json` and `en.json` with the desktop app. **Do not duplicate translations** — make mobile-side changes to those files instead.

## Settings UI

See `mobile/app/language-settings.tsx`. The screen persists user choice via `mobile/src/storage/preferences.ts` (functions: `loadUiLanguage`, `saveUiLanguage`).
