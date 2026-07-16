# Simplified Chinese Localization

Status: Active policy

Last reviewed: 2026-07-16

## Source Of Truth

Simplified Chinese (`zh`) is Orca's human-reviewed Chinese source locale. The
Traditional Chinese catalog (`zh-TW`) is generated from it and must not be
edited independently.

The authoritative Simplified Chinese copy lives in the localization policy
modules, not in machine-translation cache output:

- `config/scripts/locale-zh-human-key-overrides.mjs` combines context-specific
  full-key overrides.
- `config/scripts/locale-zh-human-value-overrides.mjs` contains standalone terms
  that are safe to reuse only when the complete English value matches.
- `config/scripts/locale-zh-phrase-fixes-human.mjs` contains narrowly guarded
  repairs for recurring legacy wording.
- `src/renderer/src/i18n/locales/zh.json` is the materialized Simplified Chinese
  catalog.
- `src/renderer/src/i18n/locales/zh-TW.json` is generated from `zh.json`.

As of 2026-07-16, the catalog has 10,804 keys. The human policy contains 2,260
full-key overrides, 246 full-value overrides, and 40 guarded phrase fixes. All
full-key entries are unique, exist in the English catalog, and preserve their
interpolation variables.

## No Machine Translation

Do not use an external translation API, LLM translation pass, browser
translator, or unattended bulk translation for Simplified Chinese. In
particular, do not run:

- `pnpm run bootstrap:zh-catalog`
- `pnpm run bootstrap:locale-catalog -- --locale zh`
- any one-off script that sends Orca copy to a translation service

`pnpm run sync:localization-catalog` is structural rather than semantic, but it
copies new English fallbacks into locale catalogs. Do not run it blindly for
Chinese. Add reviewed Simplified Chinese overrides for every new key, then run
the repair and verification workflow below.

## Translation Rules

Use complete key-level translations whenever meaning depends on the call site.
Short English words such as `Open`, `Review`, `Profile`, or `Neutral` are too
ambiguous for a global replacement.

Preserve placeholders exactly, including names such as `{{value0}}`,
`{{count}}`, and `{{term}}`. Preserve brands, provider names, CLI commands,
paths, URLs, protocol names, language names, and code literals.

Use direct second-person copy: `你` and `你的`, never `您` or `您的`.

Do not build translated sentences from independently translated English
fragments. Give dynamic counts and statuses a complete localization key so
Chinese word order and units can be expressed naturally.

## Core Terminology

| English concept      | Simplified Chinese |
| -------------------- | ------------------ |
| agent / coding agent | 智能体             |
| terminal             | 终端               |
| commit               | 提交               |
| repository / repo    | 仓库               |
| review               | 评审               |
| issue                | 议题               |
| worktree             | 工作树             |
| workspace            | 工作区             |
| browser profile      | 浏览器配置文件     |
| tab                  | 标签页             |
| cookie               | Cookie             |
| source control       | 源代码管理         |
| Mobile Emulator      | 移动端模拟器       |
| AI usage token       | token              |

Authentication credentials may retain their product spelling, such as `API
token`. AI model usage uses `token`, matching Orca's Statistics surfaces and
avoiding confusion with credentials.


## Simplified-To-Traditional Generation

`config/scripts/generate-zh-tw-catalog.mjs` uses `opencc-js` with the `cn` to
`tw` conversion profile. It protects interpolation expressions before
conversion, so application variable names are unchanged.

This is a deterministic Simplified-to-Traditional conversion, not a separate
Taiwan copywriting pass. It intentionally does not promise Taiwan-specific word
choices such as `视窗`, `重新整理`, or `快取`. Do not switch globally to a
Taiwan-phrase profile without adding protected Orca terminology and reviewing
the full catalog; generic phrase conversion can also change established terms
such as `智能体`.

## Adding Or Changing Copy

1. Add or update the English `translate()` fallback and catalog key.
2. Read the complete UI context, including labels composed around the value.
3. Add a full-key Simplified Chinese override in the closest concrete domain
   module. Split modules before they exceed the repository's max-lines limit.
4. Preserve every interpolation variable from the English source.
5. Materialize the Simplified Chinese catalog:

   ```sh
   pnpm run repair:locale-catalog -- --locale zh
   ```

6. Generate Traditional Chinese:

   ```sh
   pnpm run generate:zh-tw-catalog
   ```

7. Run the policy and catalog checks:

   ```sh
   pnpm exec vitest run --config config/vitest.config.ts \
     config/scripts/locale-translation-policy.zh-human.test.mjs \
     config/scripts/generate-zh-tw-catalog.test.mjs \
     config/scripts/verify-localization-catalog.test.mjs
   pnpm run verify:localization-catalog
   pnpm run verify:localization-coverage
   ```

Before merging, also run `pnpm run typecheck`, `pnpm run lint`, and
`git diff --check`. Treat any ordinary English sentence left in `zh.json`, any
placeholder mismatch, or any direct edit that makes `zh-TW.json` stale as a
release blocker.
