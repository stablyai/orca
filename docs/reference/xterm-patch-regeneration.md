# xterm Patch Regeneration

## Scope

Orca ships `@xterm/xterm` with four source changes it needs and upstream has
not taken: the IME composition hooks, the `xterm-composition-*` custom events
they raise, the `ITerminal` surface those events widen, and a `SortedList`
fix. pnpm applies them through `config/patches/@xterm__xterm@<version>.patch`.

That patch touches eight files. Four are hand-authored source
(`src/browser/CoreBrowserTerminal.ts`, `src/browser/Types.ts`,
`src/browser/input/CompositionHelper.ts`, `src/common/SortedList.ts`) and four
are the build output those sources produce (`lib/xterm.js`, `lib/xterm.mjs`,
and both sourcemaps). The bundle half is 7.3 MB of minified code. It is
generated, and this document exists so nobody edits it by hand.

`config/patches/xterm-src/@xterm__xterm@<version>.src.patch` is the source of
truth. Everything else is derived from it by
`config/scripts/regenerate-xterm-patches.mjs`, which is pinned to the exact
upstream commit the published tarball was built from.

This policy covers `@xterm/xterm` only. The addon patches
(`@xterm/addon-webgl`, `@xterm/addon-serialize`) are still hand-edited bundles
and are tracked separately; see [Known Gaps](#known-gaps).

## Rules

1. Never edit `config/patches/@xterm__xterm@<version>.patch`. Edit the source
   patch and regenerate.
2. Never edit `lib/` inside a patched `node_modules` tree and re-run
   `pnpm patch-commit`. That is how bundle hunks stop matching their sources.
3. Every source change must land together with the regenerated bundle hunks and
   the `pnpm-lock.yaml` hash bump, in one commit.
4. The upstream commit lives in `config/patches/xterm-upstream.json`, not in a
   comment. A version bump that leaves it stale fails the generator, it does not
   silently patch the wrong tree.
5. Sourcemaps are deleted, not patched and not silently omitted. The patch moves
   the bundle, so a retained map would have to move with it; dropping only the
   map hunks ships offsets that point at the wrong code. Deletion is the honest
   form of that saving, and `sourcemaps.policy` in the manifest controls it.
6. `--check` is the authority on the lockfile, not `pnpm install`. pnpm writes the
   patch hash in two places — `patchedDependencies` and every resolution key that
   depends on the patched package — and on a warm store it will leave the
   resolution keys at their previous value while reporting success. That installs
   locally and drifts on CI's cold store. Always finish on step 4, and if it
   reports a stale hash after an install, rerun `--write`.

## Workflow

```sh
# 1. Edit the source hunks.
$EDITOR config/patches/xterm-src/@xterm__xterm@6.1.0-beta.287.src.patch

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
git -C /tmp/xterm/upstream diff > config/patches/xterm-src/@xterm__xterm@6.1.0-beta.287.src.patch
node config/scripts/regenerate-xterm-patches.mjs --write --work-dir=/tmp/xterm
```

`--write` rewrites the source patch into the canonical form it would emit on a
re-diff, so a hand-produced `git diff` gets normalized on the first run rather
than fighting `--check` forever.

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

**Do not run `npm run setup` after the packaging build.** `setup` is the
development esbuild pass with `minify: false`. Running it afterwards overwrites
`lib/xterm.mjs` with an unminified bundle and a map that no longer matches, and
the resulting patch is silently wrong — the failure mode is a `.mjs` that is
50% larger than the published one, which is easy to miss inside a 7 MB diff.
`forbiddenBuildScripts` in the manifest encodes this and the generator refuses
to run a build step that names one of those scripts.

The generator also builds the *unmodified* commit first and asserts that it
reproduces the published `lib/` byte for byte before it emits anything. A
toolchain or build-order problem therefore surfaces as an explicit "did not
reproduce the published bundles" error rather than as 7 MB of mystery diff.

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

## Version Bumps

Bumping `@xterm/xterm` is:

1. Update the version in `package.json` and run `pnpm install`.
2. Rename both patch files to the new version and update `patch`,
   `sourcePatch`, and `version` in `xterm-upstream.json`.
3. Update `upstream.commit` to the `commit` field of the new tarball's
   `package.json`, and `toolchain` to whatever the new `package-lock.json`
   resolves.
4. `node config/scripts/regenerate-xterm-patches.mjs --write`.

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
twice, and byte-compares the result against the committed patch. A warm run is
about eight seconds of work around the clone and install.

`config/scripts/regenerate-xterm-patches.test.mjs` covers the pure pieces —
pnpm's diff flags and normalization, hunk splitting, round-trip stability, the
commit and build-order assertions, and lockfile coupling — with no network and
no build, so they run in the ordinary test shards.

## Known Gaps

`@xterm/addon-webgl` and `@xterm/addon-serialize` are still hand-edited minified
bundles. Their patches carry a literal `/* PATCH(orca): ... */` comment inside
minified code and parser round-trip artifacts, and neither patch touches its
`.map` file, so both addons currently ship sourcemaps whose offsets do not match
the shipped bundle — the defect `sourcemaps.policy` now avoids for `@xterm/xterm`
and which folding them into this manifest would also fix. Both addons build from
the same pinned commit and reproduce
byte for byte, so they can be folded into this manifest as additional `packages`
entries; that change needs e2e sign-off because, unlike `@xterm/xterm`, it will
not be a byte-for-byte no-op.
