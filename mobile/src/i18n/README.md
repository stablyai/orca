# Mobile i18n

Mobile Chinese (zh) localization via i18next + react-i18next.

## API

The mobile API mirrors the desktop renderer at `src/renderer/src/i18n/i18n.ts:43`:

```ts
// Function form (preferred for non-component code)
import { translate } from '../i18n/translate'
toast.error(translate('mobile.pair.connectionFailed', 'Connection failed'))

// Hook form (preferred in components, subscribes to language changes)
import { useTranslate } from '../i18n/useTranslate'
const { t } = useTranslate()
<Text>{t('mobile.settings.title', 'Settings')}</Text>
```

Both forms take a `key` and an English `fallback`. The fallback is the i18next `defaultValue`: when a key is missing in the active locale, the fallback renders instead of a blank path.

## Why not a `<T>` component?

The v1 design (2026-06-28) shipped a `<T>` component where `i18nKey` was optional. This led to a no-op wrapper for 612 of 944 migrated strings (the migrations omitted `i18nKey`, so `<T>Settings</T>` just rendered "Settings" verbatim). v2 (2026-06-29) replaces the wrapper with `translate(key, fallback)` — a function whose `key` and `fallback` are both required, so missing keys are caught by code review (not at runtime) and missing translations fall back to English instead of a key path.

## Translation keys

Keys live in `src/renderer/src/i18n/locales/{en,zh,es,ja,ko}.json` under a top-level `mobile.*` block. The full v2 migration ships **1004 keys** across 5 locales with strict parity (verified by `pnpm run verify:localization-catalog`). en.json is the source of truth — adding a key to any non-en locale without adding it to en.json causes the catalog verifier to fail.

Use semantic keys (`mobile.<feature>.<sub>.<field>`) for stable, reused strings. Reserve `auto.mobile.<file-without-ext>.<hash>` for one-off component copy.

For interpolated values, use single-brace i18next syntax: `{name}`, `{count}`. Use pluralization keys (`moreRow` vs `moreRows`) instead of composing count + noun in JS — translators need to control word order.

## Initialization

i18n is initialized once in `mobile/app/_layout.tsx` (Task 9) before the Stack mounts. The user's language preference is loaded from AsyncStorage (`orca:uiLanguage`) and applied to i18next.

## Testing

Unit tests cover the pure functions (`init.ts`, `translate.ts`, `useTranslate.ts`) under `mobile/src/i18n/__tests__/`. The `useTranslate` test renders a tiny `react-test-renderer` host component to verify the hook returns the `{ t, resolvedLanguage }` contract subscribers rely on. Component-level RN tests are not in scope — the mobile vitest config uses `environment: 'node'` and intentionally avoids `@testing-library/react-native` to keep test runtime low.