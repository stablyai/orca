# Arch Linux (AUR) package

This directory holds the official upstream build recipe for the
[`orca-ide`](https://aur.archlinux.org/packages/orca-ide) AUR package. `PKGBUILD` repackages the
stable release `.deb` (x86_64 and aarch64) into an Arch package: the app installs to `/opt/Orca`,
the desktop launcher and icons go under `/usr/share`, and the CLI is linked as `/usr/bin/orca-ide`.

## Install

With an AUR helper:

```sh
yay -S orca-ide
# or
paru -S orca-ide
```

Without one:

```sh
git clone https://aur.archlinux.org/orca-ide.git
cd orca-ide
makepkg -si
```

Update with your AUR helper (`yay -Syu` / `paru -Syu`). Orca's in-app updater detects that a
package manager it cannot drive owns this install and only reports that a new version exists.

## Publishing an update

`.github/workflows/aur-publish.yml` does this for you. Run it from the Actions tab with a stable
tag (for example `v1.4.214`). It downloads both `.deb` assets from that release, rewrites `pkgver`
and the `b2sums` arrays, regenerates `.SRCINFO`, and pushes to
`ssh://aur@aur.archlinux.org/orca-ide.git`. RC and other non-`vX.Y.Z` tags are rejected.

The workflow needs two repository secrets:

- `AUR_SSH_PRIVATE_KEY`: private SSH key whose public half is registered on the publishing AUR
  account. When empty, the publish job logs `AUR publishing not configured; skipping` and exits 0.
- `AUR_USERNAME`: commit author name for AUR commits (defaults to `stablyai`).

The publishing AUR account must be a co-maintainer (or the maintainer) of the existing `orca-ide`
AUR package, or the push is rejected.

To publish by hand instead:

```sh
cd aur
updpkgsums                         # from pacman-contrib; or edit the b2sums arrays
makepkg --printsrcinfo > .SRCINFO
cp PKGBUILD .SRCINFO /path/to/aur-clone/orca-ide/
cd /path/to/aur-clone/orca-ide
git commit -am "Update to <version>-<pkgrel>" && git push
```

## Editing the recipe

Pull requests that touch `aur/` run the workflow's `validate` job, which checks `PKGBUILD` syntax
and fails if `.SRCINFO` does not match `makepkg --printsrcinfo`. After any edit, run in this
directory:

```sh
makepkg --printsrcinfo > .SRCINFO
```

For a packaging-only fix to an already-published version, bump `pkgrel`; the publish job refuses
to push changed content under an unchanged `pkgver-pkgrel`.
