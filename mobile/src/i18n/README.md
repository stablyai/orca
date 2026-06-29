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

Keys live in `src/renderer/src/i18n/locales/{en,zh}.json` under a top-level `mobile.*` block. v2 PR1 ships ~30 keys (Settings + Language picker + Pair). v2 PR2 adds the remaining ~470 keys.

Use semantic keys (`mobile.<feature>.<sub>.<field>`) for stable, reused strings. Reserve `auto.mobile.<file-without-ext>.<hash>` for one-off component copy.

## Initialization

i18n is initialized once in `mobile/app/_layout.tsx` (Task 9) before the Stack mounts. The user's language preference is loaded from AsyncStorage (`orca:uiLanguage`) and applied to i18next.

## Testing

Unit tests cover the pure functions (`init.ts`, `translate.ts`, `useTranslate.ts`). No React Native component tests — the project has no RN testing infrastructure (no `@testing-library/react-native`, no RN Jest preset). Adding the infrastructure is a separate PR orthogonal to localization.