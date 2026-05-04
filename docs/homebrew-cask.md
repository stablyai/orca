# Homebrew Cask

Orca is distributed on macOS as a Homebrew Cask. This doc covers how the cask
is wired up, how it interacts with Orca's in-app updater, and what to do when
something drifts.

## For users

```bash
brew tap stablyai/orca
brew install --cask orca
```

Or in one command: `brew install --cask stablyai/orca/orca`. Both forms install
`Orca.app` into `/Applications`. Subsequent updates are handled by Orca's
in-app updater (electron-updater) — `brew upgrade` is a no-op because the
cask is marked `auto_updates true`. Users who want brew to force-reinstall
from the cask version can pass `--greedy`.

## How the pieces fit together

There are three moving parts:

1. **`Casks/orca.rb`** in this repo — source of truth for the cask file.
   Edited by automation on every stable release; can be edited manually if
   metadata (zap list, macOS floor, desc) needs to change.
2. **`stablyai/homebrew-orca`** — the public tap users consume. Mirrors
   `Casks/orca.rb` from this repo via the bump workflow. Nothing else lives
   there; do not hand-edit.
3. **`.github/workflows/homebrew-bump.yml`** — runs on `release.published`
   for stable tags (skips `-rc.*` and GitHub pre-releases). Downloads the
   two DMGs, rewrites `version`/`sha256` in `Casks/orca.rb`, pushes a PR to
   the tap, and auto-merges it.

### Why the cask uses `auto_updates true`

`electron-updater` (`src/main/updater.ts`) downloads each new release and
swaps `Orca.app` in place. Homebrew-Cask's tracking of installed versions is
based on the cask's `version:` field plus an install receipt — so when the
app mutates itself, brew's metadata drifts. `auto_updates true` tells
Homebrew this is expected: `brew outdated` and `brew upgrade` ignore the
cask unless `--greedy` is passed. Uninstall still works normally.

The hidden requirement: Squirrel.Mac (what electron-updater uses) needs
write access to `/Applications/Orca.app`. Cask installs into `/Applications`
with user ownership by default, so this works out of the box. If a user ever
`sudo`-installs or the bundle becomes root-owned, the in-app updater will
fail silently; they'd need `brew reinstall --cask orca` or `brew upgrade
--cask orca --greedy` to recover.

## One-time setup (already done, documented here for reference)

1. **Tap repo**: `stablyai/homebrew-orca` on GitHub. Must be named
   `homebrew-<anything>` so `brew tap stablyai/orca` resolves. Public.
2. **Auto-merge** enabled in tap repo settings.
3. **Seeded** with a copy of `Casks/orca.rb` for the initial version.

The workflow authenticates as the existing `buf0-bot` GitHub App
(installed org-wide on stablyai), reusing the `BUFO_BOT_PRIVATE_KEY`
secret that's already on `stablyai/orca` for `track-community-prs.yaml`.
No PAT rotation, no new secret.

## Submitting to homebrew-cask (the main tap)

The `stablyai/homebrew-orca` tap ships first. Once Orca has stable user
demand and has been on a release cadence for ~30+ days without the version
string breaking conventions (no `-rc`, no date suffixes), we can submit to
`Homebrew/homebrew-cask` so users can `brew install --cask orca` without a
tap prefix. That submission is a one-time PR against
https://github.com/Homebrew/homebrew-cask; subsequent bumps to the main tap
are handled by their own [autobump infrastructure](https://docs.brew.sh/Autobump)
as long as the release cadence matches their expectations. T3 Code's
[cask](https://github.com/Homebrew/homebrew-cask/blob/main/Casks/t/t3-code.rb)
is a close structural analogue.

## Troubleshooting

- **"electron-updater says no update available, but brew says I'm out of
  date"** — expected if the user ran `brew upgrade --greedy` or installed
  the cask before the in-app updater picked up a newer release. The
  `auto_updates true` flag usually prevents this; if a user reports it,
  check that their cask file still has the marker.
- **Bump workflow failed to PR the tap** — verify the `buf0-bot` app is
  still installed on `stablyai/homebrew-orca` (org-wide install, should
  auto-cover any new org repo). Re-run via `workflow_dispatch` with the
  tag name.
- **Squirrel-mac fails during update** — almost always bundle permissions
  or a signing-identity mismatch. See the `Why: signing identity stability`
  comment in `config/electron-builder.config.cjs` and the updater logs in
  `~/Library/Application Support/Orca/logs/`.
