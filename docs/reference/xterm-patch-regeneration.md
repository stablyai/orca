# xterm Patch Regeneration

## Scope

Orca ships `@xterm/xterm` with four source changes it needs and upstream has
not taken: the IME composition hooks, the `xterm-composition-*` custom events
they raise, the `ICompositionHelper` surface those hooks widen, and a `SortedList`
fix. pnpm applies them through `config/patches/@xterm__xterm@<version>.patch`.

That patch touches eight files. Four are hand-authored source
(`src/browser/CoreBrowserTerminal.ts`, `src/browser/Types.ts`,
`src/browser/input/CompositionHelper.ts`, `src/common/SortedList.ts`) and four
are the build output those sources produce (`lib/xterm.js`, `lib/xterm.mjs`,
and both sourcemaps). The bundle half is 7.3 MB of minified code. It is
generated, and this document exists so nobody edits it by hand.

The two halves are the same edits diffed two ways, so the generator requires
them to match byte for byte on every source file. A hunk the shipped patch
cannot name — upstream's `.npmignore` strips `src/**/*.test.ts` — would be
dropped by the next `--write`, so it fails the run instead.

`config/patches/xterm-src/@xterm__xterm@<version>.src.patch` is the source of
truth. Everything else is derived from it by
`config/scripts/regenerate-xterm-patches.mjs`, which is pinned to the exact
upstream commit the published tarball was built from.

`@xterm/addon-webgl` and `@xterm/addon-serialize` are generated the same way,
from their own source patches under `config/patches/xterm-src/`. Their entries
differ only in `packageDir` and build steps; everything below applies to all
three. `@xterm/addon-ligatures` is the one patch still written by hand — see
[Known Gaps](#known-gaps).

## Rules

1. Never edit `config/patches/@xterm__*@<version>.patch`. Edit the source
   patch and regenerate.
2. Never edit `lib/` inside a patched `node_modules` tree and re-run
   `pnpm patch-commit`. That is how bundle hunks stop matching their sources.
3. Every source change must land together with the regenerated bundle hunks and
   the `pnpm-lock.yaml` hash bump, in one commit.
4. The upstream commit lives in `config/patches/xterm-upstream.json`, not in a
   comment. A version bump that leaves it stale fails the generator, it does not
   silently patch the wrong tree.
5. Sourcemaps move with the bundle, and are never silently omitted. The patch
   moves the code, so dropping only the map hunks would ship offsets pointing at
   the wrong lines. `sourcemaps.policy` accepts `include` and nothing else: it
   costs about 5.8 MB of the emitted patch and is required because
   `src/renderer/src/components/terminal-pane/terminal-ime-xterm-transaction-events.test.ts`
   reads `lib/*.map` and asserts the mapped `Version.ts` matches the runtime
   version. Deleting the maps was once an option; the code that did it was
   removed as unreachable, so re-adding the policy means re-adding that code.
6. `--check` is the authority on the lockfile, not `pnpm install`. pnpm writes the
   patch hash in two places — `patchedDependencies` and every resolution key that
   depends on the patched package — and on a warm store it will leave the
   resolution keys at their previous value while reporting success. That installs
   locally and drifts on CI's cold store. For a version bump, follow the **Version
   Bumps** workflow through step 5 (the final `--check`); if it reports a stale hash
   after an install, rerun `--write`. For a source-only edit, the four-step workflow
   above ends at `--check`.

## Workflow

```sh
# 1. Edit the source hunks.
$EDITOR config/patches/xterm-src/@xterm__xterm@6.1.0-beta.303.src.patch

# 2. Rebuild the bundle hunks, the full patch, and the lockfile hash.
node config/scripts/regenerate-xterm-patches.mjs --write

# 3. Reinstall so node_modules picks up the new patch hash.
pnpm install

# 4. Confirm the tree is self-consistent.
node config/scripts/regenerate-xterm-patches.mjs --check
```

Editing a patch file by hand is awkward for anything larger than a one-liner.
For a substantial change, work in the generator's own checkout instead — after
any run it is left at the pinned commit with the source patch applied:

```sh
node config/scripts/regenerate-xterm-patches.mjs --check --work-dir=/tmp/xterm
$EDITOR /tmp/xterm/upstream/src/browser/input/CompositionHelper.ts
git -C /tmp/xterm/upstream diff -- src/ > config/patches/xterm-src/@xterm__xterm@6.1.0-beta.303.src.patch
node config/scripts/regenerate-xterm-patches.mjs --write --work-dir=/tmp/xterm
```

For an addon, edit under `addons/<name>/` and take the diff from that directory
with `--relative`, so the patch is rooted at the package the way the published
tarball is:

```sh
$EDITOR /tmp/xterm/upstream/addons/addon-webgl/src/TextureAtlas.ts
git -C /tmp/xterm/upstream/addons/addon-webgl diff --relative -- src/ \
  > config/patches/xterm-src/@xterm__addon-webgl@0.20.0-beta.299.src.patch
```

`--write` rewrites the source patch into the canonical form it would emit on a
re-diff, so a hand-produced `git diff` gets normalized on the first run rather
than fighting `--check` forever.

Run the checkout outside this repository. A build tree underneath it makes
`tsgo` walk up into Orca's own `node_modules` and fail with `TS2300: Duplicate
identifier`, which is a symptom of where the tree sits and not of the patch.

## How the Commit Is Known

Upstream `bin/publish.js` sets `packageJson.commit` before `npm publish`, so
each published tarball names the commit that built it. The generator asserts
that stamp against `xterm-upstream.json` and then compares the tarball's `src/`
against the checkout file by file. Only `src/common/Version.ts` may differ,
because `publish.js` rewrites the version immediately before packaging; the
generator applies the same stamp.

That pair of checks is what makes the rebuild trustworthy. Without them a wrong
commit would still produce a plausible-looking 7 MB patch.

## Build Order

Upstream's publish path is `npm ci` → stamp `Version.ts` → `npm run package`.
`npm run package` runs webpack for `lib/xterm.js` and then, via `postpackage`,
`bin/esbuild_all.mjs --prod` for `lib/xterm.mjs`.

An addon needs three steps, in this order, and the first is easy to miss:

1. **root `npm run build`.** The addon's own `npm run build` is
   `tsgo -p .` against a tsconfig whose `files` and `include` are both empty and
   which only lists project references. In `-p` mode tsgo does not build
   references, so it succeeds while emitting nothing, and the addon's webpack
   then fails on a missing `./out/`. The root build is what populates it.
2. **addon `npm run package`** — the addon's own webpack, which emits the CJS
   `lib/addon-*.js`. The root `package` script never builds this.
3. **root `npm run esbuild-package`** — `bin/esbuild_all.mjs --prod`, which emits
   the ESM `lib/addon-*.mjs` for every addon at once.

**Do not run `npm run setup` after the packaging build.** `setup` is the
development esbuild pass with `minify: false`. Running it afterwards overwrites
`lib/xterm.mjs` with an unminified bundle and a map that no longer matches, and
the resulting patch is silently wrong — the failure mode is a `.mjs` that is
50% larger than the published one, which is easy to miss inside a 7 MB diff.
`forbiddenBuildScripts` in the manifest encodes this and the generator refuses
to run a build step that names one of those scripts.

The generator also builds the _unmodified_ commit first and asserts that it
reproduces the published `lib/` byte for byte before it emits anything. A
toolchain or build-order problem therefore surfaces as an explicit "did not
reproduce the published bundles" error rather than as 7 MB of mystery diff.

## Recovering From Hand-Edited Bundles

Between 2026-08-09 and 2026-08-17 this harness did not exist, and four fixes
landed by editing the minified bundles directly. The tell is code no minifier
emits: `const` in an otherwise `let`-only bundle, and identifiers like `$rl`,
`$hp`, `$tid`.

Recovery is not a rewrite. The hand-edits were applied to `src/` as well, so the
source hunks in the shipped patch were already correct and `--write` re-derives
the bundles from them. What changes is cosmetic and expected:

- Hand-written locals collapse back into minifier names, which shifts esbuild's
  frequency-ordered allocation and can swap two short names bundle-wide (`i`↔`t`
  in the `.mjs`, `w`↔`y` in the `.js`). Most differing lines are the same length.
- Hand-written equivalents normalize to what the toolchain actually emits
  (`!!x` back to `Boolean(x)`, an escaped `\u200E` back to the literal
  character).

To confirm a regeneration is semantically a no-op rather than a revert, compare
identifier multisets between the old and new bundle instead of reading the diff:
every name that is not a single-letter minifier local should appear the same
number of times in both. Anything else is a real change and needs explaining.

## The Lockfile Moves With the Patch

pnpm derives the `patchedDependencies` hash in `pnpm-lock.yaml` — and the
`.pnpm/@xterm+xterm@<version>_patch_hash=<hash>/` store directory name — from
the sha256 of the patch file itself. A regenerated patch without the lockfile
bump fails `pnpm install --frozen-lockfile` on every machine except the
author's. `--write` makes that edit; `--check` fails if it is missing.

`config/scripts/regenerate-xterm-patches.test.mjs` asserts the same thing
without a network or a build, so the ordinary test job catches lockfile drift
in milliseconds even though the full rebuild runs in its own CI lane.

## Toolchain Pin

`toolchain` in the manifest records what upstream's `package-lock.json` resolves
at the pinned commit, and the generator fails if `npm ci` produces something
else. The entry that matters is `@typescript/native-preview`
(`tsgo`), which upstream pins to a **dated development build** —
`7.0.0-dev.20260521.1` at the time of writing. It is a real published version
and npm does not prune old releases, but it is the one dependency of this scheme
that is not a stable release.

If that version ever becomes unresolvable the generator fails with a toolchain
error naming it. Recovery is to move the pin to the next upstream commit whose
`package-lock.json` resolves, re-verify that the rebuild still reproduces the
published bundles, and regenerate. The committed patch keeps working the whole
time — only regeneration is blocked, so this is never an outage.

## Patch Path Rooting

A published tarball is rooted at the package, so an addon's patch names
`src/TextureAtlas.ts`, not `addons/addon-webgl/src/TextureAtlas.ts`. Two places
have to agree with that, and both fail silently if they do not:

- The checkout diff passes `--relative`, which must sit **before** the `--`
  separator in `CHECKOUT_DIFF_FLAGS`. After it, git reads it as a pathspec and
  keeps repo-root-relative paths, and every source hunk then falls out of the
  emitted patch.
- `git apply` runs from the repo root with `--directory=<packageDir>`. Run from
  a subdirectory instead, git still resolves patch paths from the repo root,
  skips every hunk, and **exits 0**. The generator guards this by failing when
  applying a source patch leaves the checkout unchanged.

## Version Bumps

Upstream publishes each package only when its own output changes, so the four
packages carry different beta numbers while sharing one commit — at the time of
writing `@xterm/xterm@6.1.0-beta.303` and `@xterm/headless@6.1.0-beta.302` are
both built from `d3e32b3`. Match on `package.json.commit`, never on the version
string; `xterm-user-scrolling-contract.test.ts` asserts that pairing for
headless and core.

Bumping `@xterm/xterm` is:

1. Update the version in `package.json` and run `pnpm install`.
2. Rename both patch files to the new version and update `patch`,
   `sourcePatch`, and `version` in `xterm-upstream.json`.
3. Update `upstream.commit` to the `commit` field of the new tarball's
   `package.json`, and `toolchain` to whatever the new `package-lock.json`
   resolves.
4. `node config/scripts/regenerate-xterm-patches.mjs --write`.
5. `pnpm install`, then `--check`. On a bump the lockfile has no entry under the
   new key yet, so `--write` reports the gap and leaves the hash to `pnpm
install`; `--check` is what proves the two agree afterwards.

Step 4 is where a real upstream conflict shows up: `git apply` of the source
patch fails against the new tree. Resolve it in the checkout, re-diff, and
rerun. The bundle hunks need no attention at any point.

## Why Not Vendor a Fork

A vendored `@xterm/xterm` fork removes the patch entirely, but it moves Orca off
the published package, so every upstream beta becomes a merge rather than a
version bump, and Orca inherits responsibility for building and publishing a
package it does not own. The patch is four small source hunks against a commit
that reproduces byte for byte; a fork is a much larger standing cost for the
same result.

## Why Not Handle Composition at Runtime

`CompositionHelper` hooks four private call sites upstream of `onData`, and
`SortedList` has no public surface at all. There is no supported extension point
that reaches either, so a runtime shim would mean reaching into `_core`
internals that upstream renames freely between betas. The patch is the smaller
risk.

## CI Contract

`xterm_patch_sync` in `.github/workflows/pr.yml` runs
`regenerate-xterm-patches.mjs --check` on every PR and is part of the `verify`
aggregate. It clones the pinned commit, installs upstream's toolchain, builds
twice, and byte-compares the result against the committed patch. Both builds and
the diff together are about eight seconds; `npm ci` for upstream's toolchain is
what the job actually spends its minutes on, and the cache key is the manifest.

`config/scripts/regenerate-xterm-patches.test.mjs` covers the pure pieces —
pnpm's diff flags and normalization, hunk splitting, round-trip stability, the
commit and build-order assertions, and lockfile coupling — with no network and
no build, so they run in the ordinary test shards.

## Known Gaps

`@xterm/addon-ligatures` is still patched by hand, and can stay that way: the
patch is a fifteen-line `package.json` edit that repoints `module` and adds an
`exports` block, touching no bundle and no sourcemap. Nothing about it is
generated, so there is nothing for this harness to verify.

The addons were folded into this manifest on 2026-08-29. Before that they were
hand-edited minified bundles carrying a literal `/* PATCH(orca): ... */` comment
inside minified code, parser round-trip artifacts (`!0` printed back as `true`,
locals renamed `i` → `i5`), and no `.map` hunks at all — so both shipped
sourcemaps whose offsets did not match the bundle beside them. All four
`@xterm/addon-webgl` artifacts and all four `@xterm/addon-serialize` artifacts
now reproduce byte for byte from the pinned commit, which is what closed it.

The one thing still unproven is that this holds across upstream revisions rather
than at this commit. `addon-serialize.js.map` did not reproduce on the first
attempt here; the cause was a stale `out/` from a wrong build order, not
upstream nondeterminism, and it reproduced exactly once the root build ran
first. Treat a future non-reproducing artifact as a build-order bug until proven
otherwise.
