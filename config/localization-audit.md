# Localization Audit

This is the pre-work artifact for migrating Orca to a localized UI. The goal is
to make coverage repeatable: every detected user-facing string is either moved
behind the localization layer or explicitly excluded with a reason.

## Coverage Contract

Coverage means all strings matching the audit scope below are accounted for:

- JSX text rendered in the renderer.
- Accessibility and form attributes such as `aria-label`, `ariaLabel`, `alt`,
  `placeholder`, `title`, `label`, `description`, `subtitle`, and `tooltip`.
- User-facing object metadata such as Settings search `title`, `description`,
  `keywords`, labels, badges, helper text, and tooltips.
- User-facing calls such as `toast.success(...)`, `toast.error(...)`, browser
  `alert(...)`, `confirm(...)`, and `prompt(...)`.

The audit intentionally does not treat these as localization misses unless they
are surfaced directly as UI copy:

- Terminal output, agent output, git output, provider API errors, and shell
  commands.
- File paths, URLs, environment variables, telemetry event names, IDs, and
  protocol names.
- Developer logs, internal diagnostics, test fixtures, and snapshots.
- Brand, provider, model, command, and product names that should remain exact.

## Inventory Command

Generate a machine-readable inventory:

```sh
node config/scripts/audit-localization-coverage.mjs --json --output tmp/localization-candidates.json
```

Generate a reviewable Markdown inventory:

```sh
node config/scripts/audit-localization-coverage.mjs --markdown --output tmp/localization-candidates.md
```

Run the maintained coverage gate:

```sh
pnpm run verify:localization-coverage
```

Sync catalog keys after adding or removing `translate(...)` calls:

```sh
pnpm run sync:localization-catalog
```

The sync command adds missing `en.json` entries from each call's string fallback,
copies untranslated English placeholders into other locale catalogs to keep
parity, removes locale entries whose English key was deleted, and repairs
placeholder mismatches. Run the machine-translation bootstrap commands only when
refreshing real translations, not for ordinary UI copy changes.

The coverage gate compares current candidates against
`config/localization-coverage-allowlist.json`. The committed allowlist is empty:
new candidates fail the check and must be localized or added with a reviewed
reason in the same change.

The script scans `src/renderer/src` by default. That is the primary UI surface.
Use `--source-root src` for a wider audit when checking renderer-adjacent shared
copy, then classify non-renderer findings carefully because many are diagnostics
or external tool text.

## Migration States

Each candidate should end in one of these states:

- `localized`: the component reads the string from the locale catalog.
- `excluded`: the string is intentionally not localized, with a reason from the
  coverage contract.
- `deferred`: the string is user-facing but belongs to a later PR wave.

`deferred` is acceptable for planning, but not for the localization coverage
gate.

## PR Waves

Recommended migration order:

1. Infrastructure, English catalog, language setting, and language selector.
2. Settings shell, Settings search metadata, and Appearance.
3. App shell, sidebars, titlebar, status bar, command surfaces, and global
   dialogs/toasts.
4. Task pages, source control, hosted review, and provider-specific UI.
5. Terminal chrome, onboarding, feature tips, mobile, browser, and remaining
   secondary surfaces.

## Proof Strategy

The final gate should combine three checks:

1. Scanner coverage: no unclassified localizable candidates remain.
2. Catalog coverage: every supported locale has the same keys as English, with
   matching interpolation variables.
3. Runtime coverage: pseudo-localization and real locale smoke tests show no
   obvious English leftovers or layout clipping in core screens.

Subagent or human review should verify ambiguous exclusions, but the scanner is
the coverage source of truth.
