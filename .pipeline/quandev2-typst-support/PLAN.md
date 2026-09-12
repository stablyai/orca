# Typst Monaco Language Support

## Step 1: Vendor upstream grammar and attribution

**Files:**
- `src/renderer/src/lib/monaco-languages/textmate-grammars/typst.tmLanguage.json` (new)
- `src/renderer/src/lib/monaco-languages/textmate-grammars/typst-LICENSE.txt` (new)

**Work:** Copy Typst's maintained `tools/support/typst.tmLanguage.json` unchanged from the Typst repository. Add the Apache-2.0 license with a short upstream attribution, matching the co-located Nim grammar-license convention.

**Acceptance:** The JSON grammar declares `scopeName: "source.typst"`; the license file identifies Typst and contains the Apache License 2.0 terms required for redistribution.

## Step 2: Add lazy TextMate registration

**Files:**
- `src/renderer/src/lib/monaco-languages/register-typst.ts` (new)

**Work:** Follow `register-nim.ts`: expose the Typst language and scope constants, a Monaco configuration for `//` and `/* ... */` comments, `()`, `[]`, `{}` bracket/auto-closing/surrounding pairs, and double-quoted strings. Lazily dynamic-import the vendored grammar only when `source.typst` is requested. Register `typst` with `.typ` and aliases `Typst`/`typst` through `registerTextMateLanguage`.

**Acceptance:** Calls with an unrelated scope resolve `null`; repeated registration leaves the existing registry untouched through the shared idempotency guard; no tokenizer pipeline or runtime dependency is added.

## Step 3: Wire editor and file detection

**Files:**
- `src/renderer/src/lib/monaco-setup.ts`
- `src/renderer/src/lib/language-detect.ts`

**Work:** Import and invoke `registerTypstLanguage` alongside the existing custom TextMate languages. Map `.typ` to `typst` in `EXT_TO_LANGUAGE`.

**Acceptance:** Both standard Monaco editors and diff editors receive the registered language via the single global Monaco setup; case-insensitive `.typ` detection returns `typst`.

## Step 4: Add focused contract tests

**Files:**
- `src/renderer/src/lib/language-detect.test.ts`
- `src/renderer/src/lib/monaco-languages/register-typst.test.ts` (new)

**Work:** Assert `.typ` detection, registration metadata (ID, extension, aliases, scope-backed provider, and language configuration), lazy grammar shape/scope, unrelated scope handling, and registration idempotency using the Nim registration test pattern.

**Acceptance:** Tests prove the requested registration contract without exercising a second tokenizer framework or unrelated languages.

## Step 5: Verify and clean up

**Files:** All changed files above.

**Work:** Run focused Vitest tests for language detection and Typst registration, then `pnpm run typecheck:web`. Inspect the changed-file set for scope compliance; do not stage, commit, or push.

**Acceptance:** Both focused tests and web typecheck exit successfully. Final report lists changed files, exact verification commands/results, and the Apache-2.0 attribution decision.
