# Arch Linux (AUR) package support (#45651)

## Summary

Arch Linux users can now install Orca with an AUR helper (`yay -S orca-ide` / `paru -S orca-ide`)
instead of launching the AppImage by hand. The package installs the desktop launcher and icons and
the `orca-ide` CLI at `/usr/bin/orca-ide`.

- `aur/PKGBUILD` is the official upstream recipe for the existing `orca-ide` AUR package. It
  repackages the stable release `.deb` (x86_64 and aarch64), matching the working community recipe:
  it extracts `data.tar.*` with bsdtar, sets `chrome-sandbox` to 4755, links `/usr/bin/orca-ide`,
  installs the MIT LICENSE and drops `/usr/share/doc`. Runtime deps are mapped from the `.deb`
  `Depends`.
- The checksums are real b2sums of the v1.4.214 release assets (`orca-ide_1.4.214_amd64.deb`,
  `orca-ide_1.4.214_arm64.deb`) and of `LICENSE` on `main`. None of them is `SKIP`.
- `.github/workflows/aur-publish.yml` validates `aur/` on PRs and, on manual dispatch with a stable
  `vX.Y.Z` tag, re-hashes the release `.deb` assets, renders `PKGBUILD` and `.SRCINFO`, and pushes
  to the AUR. If `AUR_SSH_PRIVATE_KEY` is unset it logs "AUR publishing not configured; skipping"
  and exits 0.
- The install docs gain an AUR download link, a comparison-table row and an "Arch Linux (AUR)"
  subsection.

Not included (possible follow-up): calling `aur-publish.yml` from `release-cut.yml` the way
`homebrew-bump.yml` is called. For now publishing is a manual `workflow_dispatch`, so it stays
opt-in until the AUR co-maintainer access and secrets exist.

## Files

Added:

- `aur/PKGBUILD`
- `aur/.SRCINFO`
- `aur/README.md`
- `.github/workflows/aur-publish.yml`
- `CHANGES.md`

Modified:

- `docs/site/content/docs/install.mdx`

## Local validation

Already run on an Arch host:

```sh
bash -n aur/PKGBUILD

# .SRCINFO in sync (same check as the CI validate job)
w=$(mktemp -d); cp aur/PKGBUILD "$w/"
(cd "$w" && makepkg --printsrcinfo) >"$w/gen" && diff -u aur/.SRCINFO "$w/gen"

# checksums match the real release assets
curl -fsSLO https://github.com/stablyai/orca/releases/download/v1.4.214/orca-ide_1.4.214_amd64.deb
curl -fsSLO https://github.com/stablyai/orca/releases/download/v1.4.214/orca-ide_1.4.214_arm64.deb
b2sum orca-ide_1.4.214_*.deb    # compare with b2sums_x86_64 / b2sums_aarch64

# full package build (needs fakeroot from base-devel)
cd aur && makepkg -s && namcap orca-ide-*.pkg.tar.zst
```

Also checked: `package()` run against the real amd64 `.deb` produced
`/usr/bin/orca-ide -> /opt/Orca/resources/bin/orca-ide`, `/opt/Orca/chrome-sandbox` with mode
4755, `/usr/share/applications/orca-ide.desktop`, the icons, and
`/usr/share/licenses/orca-ide/LICENSE`, with no `/usr/share/doc`. That run called `package()`
directly because fakeroot is not installed on this host, so a full `makepkg -s` and namcap have
not been run yet. The workflow YAML parses with PyYAML, and its render script was run on a dummy
`1.4.215` bump and gave correct `pkgver`, checksum arrays and `.SRCINFO`.

## Required repository secrets

- `AUR_SSH_PRIVATE_KEY`: private SSH key for the publishing AUR account. That account must be a
  co-maintainer (or the maintainer) of the existing `orca-ide` AUR package. If the secret is
  empty, publishing is skipped.
- `AUR_USERNAME`: commit author name for AUR commits. Optional; defaults to `stablyai`.

Note on the first publish: the AUR currently has a community `1.4.214-1`. Because the upstream
recipe differs, the publish job will refuse to push `1.4.214-1` again. Either bump `pkgrel=2` in
`aur/PKGBUILD` (and regenerate `.SRCINFO`) or make the first publish with the next stable tag.

## Suggested branch

`fix/45651-arch-linux-package-support`

## Suggested commit message

```
feat(linux): add official Arch Linux AUR package (orca-ide)

Add aur/PKGBUILD and .SRCINFO that repackage the stable release .deb for
x86_64 and aarch64, with a desktop launcher and /usr/bin/orca-ide. Add an
aur-publish workflow that validates aur/ on PRs and, on manual dispatch
with a stable tag, re-hashes the release assets and pushes to the AUR.
Document AUR install in the Linux install docs.

Closes #45651
```

## PR description

```markdown
## Summary

Closes #45651. Arch Linux users can now install Orca from the AUR instead of running the AppImage
by hand:

    yay -S orca-ide    # or: paru -S orca-ide

- `aur/PKGBUILD` + `aur/.SRCINFO`: official upstream recipe for the existing `orca-ide` AUR
  package. It repackages the stable `.deb` (x86_64/aarch64) into `/opt/Orca`, installs the desktop
  launcher and icons, links `/usr/bin/orca-ide`, sets `chrome-sandbox` to 4755, and installs the
  MIT license. The deps are mapped from the `.deb` `Depends`. It conflicts with/provides the other
  community Orca packages so users don't end up with two installs. The checksums are real b2sums
  of the v1.4.214 assets.
- `.github/workflows/aur-publish.yml`:
  - `validate` (PRs touching `aur/**`): `bash -n PKGBUILD`, then checks that `.SRCINFO` matches
    `makepkg --printsrcinfo` (run as a non-root user in `archlinux:base-devel`).
  - `publish` (`workflow_dispatch`, stable `vX.Y.Z` tags only): downloads both `.deb` assets with
    `gh release download`, computes b2sums, rewrites `pkgver`/`pkgrel`/checksums, regenerates
    `.SRCINFO`, and pushes to `aur.archlinux.org/orca-ide.git`. It skips cleanly when
    `AUR_SSH_PRIVATE_KEY` is not set. It refuses to push changed content under an unchanged
    `pkgver-pkgrel`. Permissions: `contents: read`.
- `aur/README.md`: install, publishing, and co-maintainer requirements.
- `docs/site/content/docs/install.mdx`: AUR link in the downloads list, a row in the Linux
  comparison table, and an "Arch Linux (AUR)" subsection that cross-links the existing note that
  the in-app updater leaves distro-managed builds alone.

## Setup needed before first publish

- The publishing AUR account must be added as a co-maintainer of `orca-ide` on the AUR.
- Add repository secrets `AUR_SSH_PRIVATE_KEY` and (optionally) `AUR_USERNAME`.
- The AUR currently has a community `1.4.214-1`. Publish the next stable tag, or bump `pkgrel` to
  2 first.

## Testing

- `bash -n aur/PKGBUILD`; `.SRCINFO` diff against `makepkg --printsrcinfo` is clean.
- b2sums verified against the downloaded v1.4.214 `.deb` assets.
- Ran `package()` against the real amd64 `.deb`: the resulting tree has the desktop file, icons,
  `/usr/bin/orca-ide` symlink, 4755 `chrome-sandbox`, and the license, with no `/usr/share/doc`.
- Ran the workflow's render script on a dummy version bump and checked the output.
- Not yet run: a full `makepkg -s` (fakeroot was missing locally) and `namcap`.

Follow-up (not in this PR): call `aur-publish.yml` from `release-cut.yml` next to
`homebrew-bump`, once the AUR access is set up.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
