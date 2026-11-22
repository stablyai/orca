# Arch Linux pacman repository

This directory builds Orca's **official pacman repository**: native Arch binary packages
(`.pkg.tar.zst`, the Arch equivalent of a `.deb`) plus a signed pacman repo database, published on
GitHub Releases. It is not an AUR package and is not submitted to the AUR.

- `PKGBUILD`: the source-of-truth recipe. It repackages the stable upstream `.deb` release asset
  into `orca-ide`; nothing is compiled.
- `build.sh`: renders the PKGBUILD for one release (pkgver, checksums), runs `makepkg` per
  architecture, and builds the repo database with `repo-add`.
- `.github/workflows/arch-repo-publish.yml`: validates changes here on pull requests and publishes
  a release on manual dispatch.

## Published layout

`repo-add` keys entries by package name, so one database cannot hold both the x86_64 and the
aarch64 `orca-ide`. Each architecture therefore gets its own GitHub release, both marked as
prereleases (and never "latest") so they cannot become the app's latest release:

- `arch-repo-x86_64`: `orca.db`, `orca.db.sig`, `orca.files`, `orca.files.sig`,
  `orca-ide-<ver>-<rel>-x86_64.pkg.tar.zst`, its `.sig`, `orca-arch-key.asc`, `VERSION`
- `arch-repo-aarch64`: the same, with `orca-ide-<ver>-<rel>-aarch64.pkg.tar.zst` and its `.sig`

`orca.db` and `orca.files` are real copies, not symlinks, because release assets cannot be
symlinks. Each publish replaces the package and prunes the old one, so the repo always holds
exactly the current stable version. Users point pacman at both with one line:

```
[orca]
SigLevel = PackageRequired DatabaseRequired TrustedOnly
Server = https://github.com/stablyai/orca/releases/download/arch-repo-$arch
```

User-facing install steps live in `docs/site/content/docs/install.mdx`.

## Building locally

On Arch, or in an `archlinux:base-devel` container, as a regular user (makepkg refuses root):

```
sudo pacman -S --needed base-devel pacman-contrib gnupg github-cli
```

`makepkg` and `repo-add` ship with pacman, and `fakeroot` with `base-devel`.

Unsigned smoke test, which downloads the release `.deb` files:

```
packaging/arch/build.sh 1.4.214 /tmp/orca-arch-out
```

Signed release build:

```
GPGKEY=<key-fingerprint> GNUPGHOME=<dir-with-secret-key> packaging/arch/build.sh 1.4.214 out
```

Set `ORCA_DEB_DIR=<dir>` to reuse already-downloaded `orca-ide_<ver>_{amd64,arm64}.deb` files,
and `ARCHES=x86_64` to build one architecture. An x86_64 host builds the aarch64 package too,
because the package only repackages a binary. `build.sh` passes `CARCH` through a temporary
`makepkg.conf` and unsets inherited makepkg environment overrides so the target architecture
is always honored, then checks the `arch` field in `.PKGINFO`.

## Signing key

The repository is signed with a dedicated CI key that has no passphrase. Its armored private half
lives only in the `ARCH_GPG_PRIVATE_KEY` repository secret, and the optional `ARCH_GPG_KEY_ID`
secret pins which key to use. **Never commit the private key.** The public half is published as
`orca-arch-key.asc` on each repo release, and the fingerprint appears in the release notes. If
`ARCH_GPG_PRIVATE_KEY` is not set, the publish job logs that signing is not configured and exits
successfully without publishing.

To create the key once:

```
gpg --batch --passphrase '' --quick-gen-key 'Orca Arch Repository <...>' ed25519 sign never
gpg --armor --export-secret-keys <fingerprint>   # paste into ARCH_GPG_PRIVATE_KEY
```
