# Official Arch Linux pacman repository (#45651)

## Summary

This replaces the rejected AUR approach. The earlier AUR PR was closed because an AUR `orca-ide`
already exists and the owner asked for something else: native Arch binary packages, the Arch
equivalent of a `.deb`. This is the corrected implementation.

- `packaging/arch/PKGBUILD` is the upstream recipe. It repackages the stable release `.deb` into
  `orca-ide-<ver>-<rel>-<arch>.pkg.tar.zst` for x86_64 and aarch64, which `pacman -U` installs
  directly. It sets `chrome-sandbox` to 4755, adds the `/usr/bin/orca-ide` symlink and the LICENSE,
  and drops `/usr/share/doc`.
- `packaging/arch/build.sh` downloads (or reuses) the release `.deb` files, injects real b2sums,
  and runs `makepkg` once per architecture. It also signs the packages, builds the repo database
  with `repo-add --sign`, and exports the public key.
- `.github/workflows/arch-repo-publish.yml` runs a smoke test on pull requests. On manual
  dispatch with a stable `vX.Y.Z` tag, it publishes the signed repo to GitHub Releases.
- The install docs gain an Arch Linux section covering the pacman repo and a direct
  `pacman -U` install.

**Deviation from the original spec: one release per architecture.** `repo-add` keys database
entries by package name, so a single `orca.db` cannot hold both the x86_64 and the aarch64
`orca-ide`; adding the second one replaces the first. The repo is therefore published on two
prerelease tags, `arch-repo-x86_64` and `arch-repo-aarch64`. Neither is ever marked latest. One
`pacman.conf` entry covers both architectures:

```
[orca]
SigLevel = PackageRequired DatabaseRequired TrustedOnly
Server = https://github.com/stablyai/orca/releases/download/arch-repo-$arch
```

Each tag carries `orca.db`, `orca.db.sig`, `orca.files`, `orca.files.sig`, the
`orca-ide-*.pkg.tar.zst` file and its `.sig`, `orca-arch-key.asc`, and `VERSION`. `orca.db` and
`orca.files` are real copies, not symlinks.

**Publish ordering.** The workflow uploads the package first, then the database, and only then
deletes stale `.pkg.tar.zst`, `.sig`, and database assets. The key asset is always kept. Deleting
first would leave a window with no database at all; this order means the published database
never points at a package that is missing.

## Review fixes (#46865)

CodeRabbit findings addressed in `.github/workflows/arch-repo-publish.yml`:

- **Full fingerprint.** After importing the key, the `Import signing key` step resolves the full
  fingerprint with `gpg --with-colons --fingerprint` (the `fpr:` record of the single matching
  primary key, validated as 40-64 hex) and exports it as `FINGERPRINT_BUILDER`. That fingerprint
  is passed as `GPGKEY` to `build.sh` and printed in the release notes. `ARCH_GPG_KEY_ID` is now
  only an optional selector and may be a short ID; the step fails clearly if no unique full
  fingerprint with a secret key can be resolved.
- **Safe DB/signature update.** Packages are still uploaded first. Before the DB/sig upload, the
  currently published `orca.db`, `orca.files`, `orca.db.sig`, and `orca.files.sig` (whichever
  exist) are downloaded with `gh release download --pattern` into a separate temp backup dir. If
  the DB/sig/key/VERSION upload fails, the previous assets are restored with `--clobber`, any
  DB/sig asset that did not exist before is deleted, and the job exits 1. The upload runs under
  `set +e` with an explicit status check, and stale-asset pruning only runs after a successful
  DB publish. The backup dir is removed by an `EXIT` trap.
- **Serialized publishes.** The `publish` job (not the whole workflow) has
  `concurrency: { group: arch-repo-publish, cancel-in-progress: false }`, because parallel
  publishes could prune each other's packages. PR validation runs are not queued behind it.

The in-app updater already treats a pacman package built from the `.deb` as externally managed.
See `isExternallyManagedLinuxInstall` in
`src/main/updater/linux-package/linux-update-package-type.ts`: it sees the deb marker but no
dpkg file list. No app code changes are needed.

## Files

Added:

- `packaging/arch/PKGBUILD`
- `packaging/arch/build.sh`
- `packaging/arch/README.md`
- `.github/workflows/arch-repo-publish.yml`
- `CHANGES.md`

Modified:

- `docs/site/content/docs/install.mdx`: Arch Linux added to the Linux download bullet, a
  `pacman` row in the package table, a new `#### Arch Linux (pacman repository)` section, the
  generic "distro-managed" note no longer names AUR, and the CLI bullet now mentions Arch
  packages.

## Validation performed locally

- `bash -n packaging/arch/build.sh` and `bash -n packaging/arch/PKGBUILD` both pass.
- The PKGBUILD checksums are real b2sums of the v1.4.214 `orca-ide_1.4.214_{amd64,arm64}.deb`
  assets and of `LICENSE` on `main`, computed from downloaded files.
- **A real end-to-end signed build passed** on an Arch host. It used makepkg/repo-add 7.x, a
  test-only fakeroot on PATH, and a throwaway local GPG key:
  `CARCH=bogus PKGDEST=/nonexistent ORCA_DEB_DIR=<debs> GPGKEY=<key> packaging/arch/build.sh 1.4.214 <out>`.
  The bogus inherited `CARCH`/`PKGDEST` confirm that the overrides are neutralized. Checked for
  both architectures:
  - `.PKGINFO` `arch` is correct
  - the depends list matches the spec
  - `opt/Orca/chrome-sandbox` is `-rwsr-xr-x`
  - `usr/bin/orca-ide -> /opt/Orca/resources/bin/orca-ide`
  - LICENSE is installed and there is no `usr/share/doc`
  - `gpg --verify` reports a good signature on the package and on `orca.db`
  - `orca.db` lists `orca-ide-1.4.214-1/desc`
  - there are no symlinks in the output
  - `pacman -Qip` shows the expected metadata
- The workflow's "Smoke test with dummy packages" script, run locally without the
  `useradd`/`runuser` wrapper, prints `Smoke test passed`.
- The YAML was not machine-parsed locally because PyYAML is unavailable. It has no tabs and the
  job/step structure was checked by grep.
- Review fixes: every `run:` block passes `bash -n`. The publish script was run against a mock
  `gh` for a successful publish (stale packages pruned), a DB-upload failure (previous DB set
  restored, newly added `orca.files.sig` deleted, no pruning, exit 1), and a non-fingerprint
  `FINGERPRINT_BUILDER` (rejected). The fingerprint resolution resolved a short key ID to the
  full 40-hex fingerprint with a throwaway GPG key.

Commands to repeat locally (Arch, non-root):

```
bash -n packaging/arch/build.sh && bash -n packaging/arch/PKGBUILD
packaging/arch/build.sh 1.4.214 /tmp/orca-arch-out                 # unsigned, downloads debs
GPGKEY=<fpr> GNUPGHOME=<dir> packaging/arch/build.sh 1.4.214 out   # signed
```

Not verified locally: the GitHub Actions run itself. In particular, the `runuser` builder user
needs read access to the workspace mounted in the container, and `gh release` publishing has not
been exercised. Run a dispatch against a fork first.

## Test artifacts

The real packages from the local end-to-end build were copied to:

- `/home/vibecat/.orca/bots/project-manager/totest/orca-pacman-repo/orca-ide-1.4.214-1-x86_64.pkg.tar.zst`
- `/home/vibecat/.orca/bots/project-manager/totest/orca-pacman-repo/orca-ide-1.4.214-1-aarch64.pkg.tar.zst`

They were signed only with a throwaway local key, so the `.sig` files were not copied. Install
for testing with `sudo pacman -U <file>`.

## Required GitHub secrets

- `ARCH_GPG_PRIVATE_KEY` (required to publish): the armored secret key of a dedicated,
  passphrase-less CI signing key. Never commit it. If it is unset, the publish job logs
  "Arch repo signing not configured; skipping" and succeeds without publishing.
- `ARCH_GPG_KEY_ID` (optional): a selector (short ID, long ID, or fingerprint) for the key to
  sign with. Without it, the first secret key in the imported keyring is used. Either way the
  workflow resolves and uses the full fingerprint.

Follow-ups:

- Call `arch-repo-publish.yml` from `release-cut.yml` after a stable desktop release (as
  `homebrew-bump.yml` is).
- Publish the key fingerprint in `install.mdx` once the key exists.

## Suggested branch

`fix/45651-arch-pacman-repo`

## Suggested commit message

```
fix(ci): harden Arch repo publishing (#46865)

Resolve the full GPG fingerprint for signing and release notes, back up
and restore the pacman DB/signatures if an upload fails, and serialize
publishes with concurrency so concurrent runs cannot prune each other's
packages.

Refs #45651
```

## PR description

```
## Summary

Adds an official, signed pacman repository for Arch Linux (#45651). This replaces the earlier
AUR-based PR, which was closed: an AUR `orca-ide` already exists, and the request is for native
Arch binary packages (the `.deb` equivalent) published by Orca itself.

- `packaging/arch/PKGBUILD`: upstream recipe that repackages the stable release `.deb` into
  `orca-ide-<ver>-<rel>-{x86_64,aarch64}.pkg.tar.zst` (`pacman -U`-installable).
- `packaging/arch/build.sh`: builds both architectures from one x86_64 Arch container (no
  compilation; CARCH is forced through a temporary makepkg.conf and asserted in .PKGINFO),
  signs packages, and builds the repo DB with `repo-add --sign`.
- `.github/workflows/arch-repo-publish.yml`: PR smoke test (dummy .debs, throwaway key, full
  makepkg + repo-add + signature checks) and a manual `workflow_dispatch` publish for a stable
  `vX.Y.Z` tag to the `arch-repo-x86_64` / `arch-repo-aarch64` prerelease tags. Publishing
  signs with the resolved full key fingerprint, rolls the DB/signature set back if its upload
  fails, and is serialized with a `concurrency` group.
- `install.mdx`: Arch Linux section with key import, `pacman.conf` entry, `pacman -Syu orca-ide`,
  and direct `pacman -U` install.

### Why one release per architecture

`repo-add` keys entries by package name, so a single `orca.db` cannot carry both architectures of
`orca-ide`. A single `Server = .../releases/download/arch-repo-$arch` line covers both.

### Setup

Add the `ARCH_GPG_PRIVATE_KEY` secret (dedicated, passphrase-less CI key; optional
`ARCH_GPG_KEY_ID` selector, resolved to the full fingerprint). Without it the publish job skips
cleanly.

### Follow-ups

- Trigger from `release-cut.yml` after stable releases.
- Publish the signing key fingerprint in the docs.

## Testing

- Real signed end-to-end build of v1.4.214 for x86_64 and aarch64 on Arch: correct arch,
  setuid chrome-sandbox, `/usr/bin/orca-ide` symlink, LICENSE, valid package and DB signatures.
- Workflow smoke-test script run locally.
- Publish script run against a mock `gh` for success, DB-upload failure with rollback, and an
  invalid fingerprint.

Refs #45651

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
