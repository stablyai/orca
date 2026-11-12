# I18n Translation Source and Automation

Date: 2026-07-29 (revised 2026-07-30)

Status: accepted architecture decision; PR A
([#8512](https://github.com/stablyai/orca/pull/8512)) merged; PR B not yet
implemented

Revision note: the original decision selected a constrained XLIFF 2.0 profile
at 80% confidence, with gettext PO as the named fallback. A tooling,
contributor-workflow, and repository-evidence review on 2026-07-30 resolved
that uncertainty against XLIFF 2.0 before PR B was built. The architecture is
unchanged; the canonical format is now gettext PO. The evidence is recorded
under "Alternatives considered".

## Goal

Reduce the recurring engineering and human work required to localize Orca
without presenting missing, copied-English, or stale values as completed
translations.

The format is not the goal. The intended steady-state workflow is:

- a feature developer adds a stable message ID and current English copy once;
- extraction discovers new and changed messages automatically;
- feature work does not wait for every target locale;
- translation automation processes only missing and stale units;
- humans review a small, risk-prioritized delta rather than whole catalogs;
- missing or stale translations safely fall back to current English; and
- deterministic, offline runtime bundles ship with the app.

## Decision

Use gettext PO as Orca's canonical bilingual translation source, under a
constrained profile:

- `msgctxt` — the stable Orca message ID;
- `msgid` — the English source, current as of the entry's last
  reconciliation;
- `msgstr` — the target translation;
- `#, fuzzy` — not approved for runtime, whether stale or newly
  machine-translated; never compiled into runtime bundles;
- `#| msgid` — the prior English source associated with the retained
  translation;
- `#.` — translator context and notes;
- `#:` — source references (optional, informational); and
- `#~` — retired entries, kept only under the retention policy below.

Product source owns stable message IDs and current English defaults. Maintained
extraction produces the current English translation source. Each target locale
owns a sparse PO file containing only translations that exist, each carrying
the English source it is keyed against.

Responsibilities are split so target catalogs never change in feature work:

- **Feature PRs** change English only: source code, inline defaults, and the
  extracted English source.
- **A read-only compiler** joins the current English source with each target
  PO file by `msgctxt` and generates the existing i18next JSON bundle shape.
  An entry whose stored `msgid` differs from current English is stale; one
  whose `msgid` is current but fuzzy is pending approval. Both are omitted so
  i18next falls back to current English.
  The compiler never writes to PO files. Generated runtime JSON is disposable
  and must not be hand-edited.
- **Post-merge localization automation** owns all PO mutations. Reconciliation
  finds entries affected by merged English changes, updates `msgid` to current
  English, preserves the old source in `#| msgid`, and sets `#, fuzzy` — so
  translators and tools see the current source, the previous source, and the
  prior translation in one unit. Reconciliation lands in localization-only
  changes, never in the originating feature change.

The reconciler — not gettext's own merge tooling — owns the join. `msgmerge`
keys entries on the `(msgctxt, msgid)` pair, so under stable IDs a source
change orphans the entry instead of marking it fuzzy. Reconciliation must join
by `msgctxt` alone.

Absence of `#, fuzzy` means approved to ship, whether approval came from a
human or an explicitly configured low-risk automation policy. Machine or human
provenance is recorded separately in a documented comment or flag; it must not
be conflated with runtime eligibility.

PO is an authoring and translation-workflow boundary, not a runtime
dependency. Orca must not require network access or a translation service to
display localized UI.

## Why this solves the work problem

The system is organized around translating only the delta:

```text
feature change: stable ID + English
                 |
                 v
       extraction and validation
                 |
                 v
    missing/changed translation queue
                 |
                 v
 machine translation + glossary/context
                 |
                 v
 placeholder and policy validation
                 |
                 v
 sparse locale bundle or English fallback
```

Feature developers do not synchronize target catalogs, copy English into
untranslated locales, run whole-catalog repair, or wait for translation
completion. A source change invalidates only the affected target units.
Unchanged translations remain byte-stable.

The bilingual source gives the compiler enough information to distinguish:

- **missing**: the locale has no entry for the ID;
- **stale**: the stored `msgid` differs from current English — true the
  moment the English change merges, before any reconciliation runs;
- **pending approval**: the stored `msgid` is current, a target exists, and
  `#, fuzzy` is set; and
- **current/approved**: the stored `msgid` is current, a target exists, and
  `#, fuzzy` is absent.

Missing, stale, and pending-approval entries are omitted from generated
target bundles so i18next uses current English. Staleness must not be inferred from Git history,
file timestamps, copied-English ratios, or a second hand-maintained database.

## Constrained PO profile

Orca will support only the subset needed for its message model. PR B must
define and validate that subset rather than accepting arbitrary PO documents.

Each supported entry must carry:

- one stable Orca message ID (`msgctxt`), unique within the file;
- the English source (`msgid`), current as of the entry's last
  reconciliation;
- an optional target value (`msgstr`) in a target-locale file;
- translator notes or UI context when provided (`#.`);
- runtime workflow state (`#, fuzzy`), with provenance recorded in the
  documented separate comment or flag; and
- the information needed to validate interpolation placeholders.

Plurals use Orca's existing per-key convention: each i18next plural-suffixed
key (`…_one`, `…_other`) is its own PO entry. The profile must not use
`msgid_plural`/`msgstr[n]`, which would collide with i18next's own CLDR plural
selection and gettext's `nplurals` model.

The compiler must reject:

- duplicate or unstable IDs (including two entries sharing a `msgctxt`);
- empty targets represented as completed translations;
- unsupported states or constructs;
- malformed source/target entries;
- nondeterministic ordering or output — the profile must document exact
  serialization normalization (entry order by `msgctxt`, fixed line folding,
  LF endings, escaping rules) so every tool in the pipeline emits identical
  bytes for identical content; and
- locale files whose declared language headers are incorrect.

Placeholder validation is state-dependent (an entry is current only when its
stored `msgid` matches current English and it carries no fuzzy flag):

- **stale or pending-approval entries**: a placeholder mismatch is expected
  mid-flight; the entry is already omitted from bundles, so validation
  reports it without failing;
- **current/approved entries**: a placeholder mismatch is a hard validation
  failure; and
- **automation and import pipelines**: a produced target with mismatched
  placeholders is demoted to fuzzy rather than committed as current.

Source comparison is a semantic comparison of parsed source strings after
documented text normalization. Line folding, wrapping, and PO escaping are
serialization concerns and must never affect comparison. Reconciliation must
never update an entry's stored source without either confirming or replacing
the target, or marking the entry fuzzy.

If translator notes or placeholder semantics can change the required
translation without changing visible English, the source-signature contract
must include that information or explicitly invalidate the entry.

Retired entries (`#~`) are kept only while they provide useful translation
memory for automation; a deterministic cleanup policy removes them rather than
letting them accumulate indefinitely.

## Message ID and placeholder policy

The current catalog undermines the stable-ID premise in two ways the format
alone cannot fix: 8,981 of 11,564 keys (77.7%) are codemod-generated content
hashes, and 825 of 954 interpolated strings use positional placeholders
(`{{value0}}`) that carry no meaning for a translator or a machine-translation
prompt.

Policy:

- hashed IDs already in the desktop catalog as of this decision (2026-07-30)
  are grandfathered as opaque stable IDs; the generating codemod must not be
  rerun against existing keys, and no mass rename happens during this
  migration;
- newly minted hash IDs — including in-flight bridge catalogs not yet merged
  or merged after this decision — are **not** grandfathered: they are renamed
  to intent-named IDs in a dedicated change adjacent to their landing, before
  PO becomes canonical for that surface, never buried inside an otherwise
  reviewed feature PR;
- new keys must use intent-named IDs and named interpolation placeholders;
- converting positional placeholders to named ones requires per-message
  semantic judgment (the name is part of the translatable contract), not a
  mechanical rename; and
- legacy IDs and positional placeholders are improved opportunistically when
  the copy itself is touched, never in bulk.

## Runtime and source ownership

The ownership chain is:

```text
product code and explicit dynamic declarations
                    |
                    v
       extracted current English source
                    |
                    v
   sparse canonical target-locale PO files
                    |
                    v
       deterministic i18next JSON bundles
                    |
                    v
       lazy-loaded offline app resources
```

Inline English defaults remain readable at call sites and provide extraction
input. Static extraction and explicit declarations for genuinely dynamic keys
must reconcile to one current English translation source. CI must reject
missing declarations and incompatible defaults rather than creating a
permanent exception database.

Renderer, Electron main, web, SSH, WSL, and packaged execution continue to
consume the same logical runtime bundles. The compiler and build paths must use
cross-platform path handling and deterministic line endings.

Two additional surfaces are in scope:

- **Mobile.** The mobile app is acquiring its own catalog tree with its own
  key scheme. Mobile must adopt the same canonical contract, ID policy, and
  compiler — with its own PO files — rather than a second bespoke pipeline.
  Mobile keys must not be folded into the desktop catalogs, and in-flight
  mobile catalog JSON is a bridge the migration replaces, not a canonical
  source. Mobile requires **two deterministic projections** from the same PO
  source: the mobile i18next JSON bundle, and the native metadata resources
  (iOS `InfoPlist.strings`, Android resources) that render before the JS
  runtime exists. i18next fallback cannot cover pre-JS surfaces, so for a
  missing, stale, or pending-approval native entry the compiler must either
  omit the locale-specific native key with proven OS/base-locale fallback on
  both platforms, or emit current English under a documented platform rule.
  The intentional locale-ID mapping (JS `zh` vs native `zh-Hans`) is part of
  the projection contract. The migration covers both projections.
- **Plugin language packs.** Language packs remain external overrides
  validated against compiled core keys. They are consumers of the contract,
  not another canonical source, and the compiler must leave their runtime
  path intact.

## Translation automation

The architecture is incomplete until translation work is delta-driven.
After the compiler and migration are stable, automation should:

1. reconcile entries affected by merged English changes (update `msgid`,
   preserve `#| msgid`, set fuzzy) and find target entries that are missing
   or stale;
2. batch only those entries into a translation change;
3. supply translator notes, glossary terms, placeholder rules, the previous
   source from `#| msgid`, and relevant existing translations;
4. preserve all unaffected target entries byte-for-byte;
5. mark runtime eligibility and provenance honestly;
6. run placeholder, terminology, formatting, and catalog validation, demoting
   invalid output to fuzzy; and
7. fall back to English rather than shipping an invalid target.

Human review should be risk-based. Destructive actions, authentication,
billing, privacy, security, legal copy, OS permission prompts (camera,
microphone, photos, local network), native app metadata, and other sensitive
flows require review. Routine labels and descriptions may use validated machine translation
under the adopted release policy. A model-provided confidence score alone is
not sufficient release evidence.

Catalog QA should include an identical-to-English guard implemented as a
ratchet with reviewed exemptions, not a blanket prohibition: brand names,
commands, and terms that legitimately remain English live in the exemption
inputs, and the untranslated ratio for everything else must not rise.

Glossary and forbidden-translation rules belong in stable QA inputs. The
existing repair-script policy data (glossaries, never-translate lists,
per-locale overrides) is converted into those inputs. They must replace
historical whole-catalog repair scripts rather than coexist with them as
another source of product behavior.

## Rollout

### PR A: decouple feature copy — merged

PR #8512:

- permits sparse target catalogs;
- makes English runtime fallback authoritative for missing values;
- makes catalog synchronization update English only;
- preserves existing target values and rejects placeholder incompatibility;
- adds maintained extraction and CI verification; and
- removes whole-catalog translation and repair commands from ordinary product
  workflows.

PR A is independently useful and format-neutral. It stops new parity work, but
it does not permanently model reviewed or stale translation state.

PR A also created a deletion ratchet: extra target-locale keys hard-fail
verification and sync no longer edits targets, so an English key cannot be
retired without hand-editing every target catalog. Orphaned English keys
(2,055 unreferenced at time of writing) grow with every rename until PR C
lands. PR C should not wait long.

### PR B: define the source and compiler

PR B must remain a small architecture and implementation proof. It should add:

1. the constrained PO profile and its serialization normalization;
2. extraction into the current English source;
3. sparse source/target parsing via maintained PO tooling;
4. deterministic, read-only i18next bundle compilation, omitting entries
   whose stored source mismatches current English or that are fuzzy — with a
   compiler shape that admits additional per-locale projections (the mobile
   native-resource output) even though PR B implements only the i18next
   bundle;
5. a separate reconciliation command owning all PO mutations (`msgid`
   update, `#| msgid` preservation, `#, fuzzy`);
6. state-dependent placeholder validation;
7. representative fixtures for interpolation, plural-suffixed keys, multiline
   copy, translator notes, and source changes; and
8. packaged-build integration across local and remote execution boundaries.

Acceptance tests must assert every workflow field — state, previous source,
notes, retirement — field-by-field through parse → modify → serialize cycles.
Byte-identical round-trip alone is not evidence: a lossy parser faithfully
reproduces its own losses, so a round-trip gate can pass while the fields that
justify the format are silently destroyed. This failure mode was demonstrated
against the dominant XLIFF library during the format review.

It must not migrate the complete locale inventory. That keeps the format and
compiler independently reviewable and makes rejection inexpensive.

### PR C: migrate existing translations once

The migration must:

- export all current stable English IDs and values;
- import real target values without retranslating them;
- preserve known reviewed corrections;
- mark unproven values as pending approval, with imported provenance —
  bridge catalogs in particular mix reused desktop translations, machine
  translation, and manual corrections, and must be classified rather than
  assumed approved;
- remove copied-English parity filler unless it is intentionally English,
  seeding the identical-to-English exemption inputs from the existing policy
  data;
- turn terminology and known mistranslations into glossary and QA inputs;
- drain the orphaned-English-key ratchet and delete the retired bootstrap and
  repair script files; and
- explain every difference between current and compiled runtime bundles.

Every existing target value must be byte-preserved, explicitly retired, or
classified as filler. No Git-history inference should remain in the permanent
runtime or verification path.

### PR D: switch ownership and delete the bridge

After bundle equivalence is proven:

- PO becomes the only editable target translation source;
- generated runtime JSON stops being a canonical input;
- development, test, build, and packaging compile the bundles
  deterministically;
- a JSON→PO importer ships for contributors, so existing full-catalog
  community PRs can be converted instead of abandoned;
- legacy bootstrap, repair, override, and migration-only bookkeeping is
  removed; and
- ordinary CI runs one focused extraction and compile verification path.

### Translation automation

The first automation follow-up should create or update localization-only
changes containing only missing and stale entries. It should not rewrite a
whole locale, modify feature code, or block the originating feature change.

## Alternatives considered

### Constrained XLIFF 2.0 — original choice, reversed 2026-07-30

XLIFF 2.0 has the best abstract schema fit: stable IDs, source and target in
one unit, standardized workflow state, and categorized notes. The decision was
reversed when the stated uncertainties resolved against it:

- the dominant JS XLIFF library silently discards `state`, `subState`, and
  note categories — the fields that motivate the format — while reporting a
  clean round-trip, so the planned acceptance gate would have passed
  vacuously; the only spec-faithful JS alternative has ~90 weekly downloads,
  a single maintainer, and EPL-1.0 licensing;
- XLIFF 2.0 core defines no previous-source mechanism, so the "what changed"
  payload for translation automation requires a custom extension that breaks
  the interoperability that justified the format (leaving the old `<source>`
  in the target file and comparing against a separate current-English file is
  possible, but then translators and tools see the wrong current source
  unless another projection is built — PO represents the joined working state
  natively);
- tool and platform support for XLIFF 2.x remains weaker than 1.2 more than a
  decade after standardization; no verified case of XLIFF 2.0 as an in-repo
  canonical source was found, and the closest public precedent for this exact
  compiler design chose 1.2; and
- XML is the format most likely to let a hand-edited community PR fail on a
  malformed entity, and there is no cross-tool XML formatting convention, so
  external editors produce whole-file diffs; Orca's translation contributions
  arrive overwhelmingly as direct catalog PRs.

If a translation provider requires XLIFF, Orca should add a deterministic
import/export adapter at the boundary rather than change the canonical
representation.

### XLIFF 1.2

Broader legacy tool support than 2.0, but more tool-specific dialects and a
less coherent data model, and it shares XML's contributor and formatting
costs. Adapter-only, as above.

### Direct JSON or TypeScript catalogs

These are simple runtime inputs, but they do not standardize source snapshots,
translator context, or review state. Meeting Orca's requirements would require
custom sidecars or object schemas and synchronization rules. That recreates
much of a bilingual standard while retaining the parity and stale-state risks
the migration is intended to remove.

### Bespoke bilingual JSON — the current fallback

A JSON schema with embedded per-locale state, source snapshots, and notes is a
proven model (a major platform vendor ships exactly this shape, with per-key
extraction state including staleness and per-locale review state) and would
add no parsing dependency. It is second to PO because PO's workflow fields are
standard rather than bespoke, existing translation editors and open tooling
understand them, and its diffs are the smallest of the three formats. If the
PR B PO proof fails, adopt this — not XLIFF — before PR C.

### Platform-native catalogs

Platform-native string catalogs provide strong translation state on their
own platform but are not a suitable authority for Orca's macOS, Linux,
Windows, web, WSL, and SSH surfaces.

### Proprietary translation platform

A translation platform may later operate on the PO boundary, but it should
not become Orca's sole source of truth or a runtime dependency. Selecting one
before the repository contract exists would create premature vendor coupling.

### Peer practice

Inspectable applications validate the architecture more strongly than any one
format:

- mature systems use stable keys or source messages, authoritative English,
  sparse targets, and runtime fallback;
- applications that keep canonical translations in-repo with PR-based
  contribution use PO or stateful JSON catalogs; none inspected uses XLIFF
  2.0 as a canonical source, and the only XLIFF observed was 1.2 as
  interchange into an external pipeline;
- the delta-driven machine-translation model this document targets is already
  shipping in peer practice, keyed by per-entry source tracking;
- structural key parity is not a completeness signal — peer catalogs exist
  with perfect parity and majority copied-English content, which is what the
  identical-to-English ratchet detects; and
- gates that are written but not enforced decay — every verification in this
  plan must run in CI from the PR that introduces it.

Closed-source applications do not publish enough of their authoring pipelines
to establish a format decision. Orca therefore chooses based on its own
requirements rather than presumed competitor internals.

## Confidence and decision gate

Confidence is:

- **97%** in the overall sparse-source, source-snapshot, deterministic-compiler,
  and English-fallback architecture;
- **90%** in PO over constrained XLIFF 2.0;
- **85%** in PO over bespoke bilingual JSON; and
- **95%** that a migration-free PR B prototype on PO is the correct next step.

The remaining PO uncertainty concerns exact serialization normalization
(folding, escaping) across the tools contributors use, the provenance
convention recorded alongside `#, fuzzy`, and the `#~` retention policy.

PR B closes the decision gate only if its representative fixtures preserve
every workflow field through parse → modify → serialize verified
field-by-field, output is deterministic, diffs remain reviewable, and the
compiler/build integration is maintainable. If that proof fails, adopt bespoke
bilingual JSON before PR C. Do not fall back to XLIFF 2.0, add compatibility
layers, or create custom sidecar state merely to preserve a format choice.

This is a deliberate, reversible senior-engineering decision — and it has
already been exercised once: the original XLIFF 2.0 selection was reversed
when evidence resolved its stated uncertainties, at zero migration cost
because the staged rollout deferred format commitment until PR B.

## Explicit non-goals

The completed system must not:

- require every target locale to contain every English key;
- copy English into target catalogs to simulate coverage;
- infer permanent translation state from Git history;
- retranslate or rewrite complete catalogs for ordinary copy changes;
- make generated runtime JSON another hand-edited source;
- rename existing hashed message IDs in bulk;
- treat plugin language packs as a canonical source;
- block feature PRs while translations catch up;
- require runtime network access; or
- maintain multiple canonical translation databases.
