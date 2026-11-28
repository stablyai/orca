#!/usr/bin/env bash
# Build Orca's official pacman repository from a published stable release.
#
#   packaging/arch/build.sh <version-without-v> <output-dir>
#
# Produces one pacman repo per architecture, because repo-add keys entries by pkgname: a single
# orca.db cannot hold both the x86_64 and the aarch64 orca-ide. Layout:
#
#   <output-dir>/x86_64/   orca.db orca.files orca-ide-<ver>-<rel>-x86_64.pkg.tar.zst  [+ .sig]
#   <output-dir>/aarch64/  orca.db orca.files orca-ide-<ver>-<rel>-aarch64.pkg.tar.zst [+ .sig]
#
# each with VERSION and, when signed, orca.db.sig, orca.files.sig and orca-arch-key.asc.
#
# Environment:
#   GPGKEY        Signing key ID/fingerprint. Its secret key must be in GNUPGHOME without a
#                 passphrase (dedicated CI key). Empty = unsigned build for local dry runs.
#   GNUPGHOME     gpg home holding that secret key (defaults to gpg's own default).
#   PKGREL        pkgrel to build (default 1).
#   ARCHES        Architectures to build (default "x86_64 aarch64").
#   ORCA_DEB_DIR  Directory with pre-downloaded orca-ide_<ver>_{amd64,arm64}.deb files. Missing
#                 files are downloaded into it. Default: a temporary directory.
#   ORCA_REPO     GitHub repo to download from (default stablyai/orca).
#
# Must run as a regular user (makepkg refuses root) inside Arch, e.g. archlinux:base-devel:
#   pacman -S --needed base-devel pacman-contrib gnupg github-cli
# makepkg/repo-add come from pacman, b2sum from coreutils, bsdtar from libarchive.
#
# Cross-arch: an x86_64 host can build the aarch64 package because nothing is compiled; the
# package only repackages the upstream binary .deb. makepkg takes the target from CARCH, which we
# set in a throwaway makepkg.conf passed via --config (that also stops ~/.makepkg.conf overrides).
# makepkg re-applies inherited CARCH/PKGDEST/SRCDEST/BUILDDIR/PKGEXT/GPGKEY env vars *after* that
# config (load_makepkg_config), so they are unset for the makepkg call and the result's .PKGINFO
# arch is asserted.
set -euo pipefail

usage() {
  echo "usage: $0 <version-without-v> <output-dir>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
version="$1"
out_root="$2"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be a stable X.Y.Z without a leading v (got: $version)" >&2
  exit 2
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "error: makepkg refuses to run as root; run build.sh as an unprivileged user" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
pkgbuild_src="$script_dir/PKGBUILD"
license_src="$repo_root/LICENSE"
pkgrel="${PKGREL:-1}"
arches="${ARCHES:-x86_64 aarch64}"
orca_repo="${ORCA_REPO:-stablyai/orca}"
gpgkey="${GPGKEY:-}"

missing=()
for cmd in makepkg fakeroot repo-add b2sum bsdtar sed; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if [[ -n "$gpgkey" ]]; then
  command -v gpg >/dev/null 2>&1 || missing+=("gpg")
fi
if ! command -v gh >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1; then
  missing+=("gh or curl")
fi
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "error: missing required commands: ${missing[*]}" >&2
  echo "hint: pacman -S --needed base-devel pacman-contrib gnupg github-cli" >&2
  exit 1
fi

for f in "$pkgbuild_src" "$license_src"; do
  [[ -f "$f" ]] || { echo "error: missing $f" >&2; exit 1; }
done
[[ -f /etc/makepkg.conf ]] || { echo "error: /etc/makepkg.conf not found (not Arch?)" >&2; exit 1; }

if [[ -z "$gpgkey" ]]; then
  echo "warning: GPGKEY is empty; building an UNSIGNED repo (local dry run only, do not publish)" >&2
else
  if ! gpg --batch --list-secret-keys "$gpgkey" >/dev/null 2>&1; then
    echo "error: secret key $gpgkey not found in GNUPGHOME=${GNUPGHOME:-~/.gnupg}" >&2
    exit 1
  fi
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

deb_dir="${ORCA_DEB_DIR:-$work/debs}"
mkdir -p "$deb_dir" "$out_root"
out_root="$(cd "$out_root" && pwd)"
# Absolute, because SRCDEST below symlinks into it.
deb_dir="$(cd "$deb_dir" && pwd)"

deb_arch_for() {
  case "$1" in
    x86_64) echo amd64 ;;
    aarch64) echo arm64 ;;
    *) echo "error: unsupported arch $1" >&2; return 1 ;;
  esac
}

fetch_deb() {
  local name="$1" dest="$deb_dir/$1"
  if [[ -s "$dest" ]]; then
    echo "==> Reusing $dest"
    return 0
  fi
  echo "==> Downloading $name from $orca_repo v$version"
  if command -v gh >/dev/null 2>&1 && { [[ -n "${GH_TOKEN:-}" ]] || gh auth status >/dev/null 2>&1; }; then
    gh release download "v$version" --repo "$orca_repo" --pattern "$name" --dir "$deb_dir" --clobber
  else
    curl --fail --location --silent --show-error --retry 3 -o "$dest.part" \
      "https://github.com/$orca_repo/releases/download/v$version/$name"
    mv "$dest.part" "$dest"
  fi
}

license_sum="$(b2sum "$license_src" | awk '{print $1}')"

for arch in $arches; do
  deb_arch="$(deb_arch_for "$arch")"
  deb_name="orca-ide_${version}_${deb_arch}.deb"
  fetch_deb "$deb_name"
  deb_sum="$(b2sum "$deb_dir/$deb_name" | awk '{print $1}')"

  build="$work/build-$arch"
  srcdest="$build/srcdest"
  pkgdest="$build/pkgdest"
  mkdir -p "$build/pkg" "$srcdest" "$pkgdest"

  # Why: pre-seed SRCDEST under the PKGBUILD's :: alias names so makepkg uses these exact files
  # instead of downloading again; the checksums below then verify them.
  cp "$license_src" "$srcdest/LICENSE"
  ln -s "$deb_dir/$deb_name" "$srcdest/orca-ide-${version}-${arch}.deb"

  sed \
    -e "s/^pkgver=.*/pkgver=${version}/" \
    -e "s/^pkgrel=.*/pkgrel=${pkgrel}/" \
    -e "s/^b2sums=.*/b2sums=('${license_sum}')/" \
    -e "s/^b2sums_${arch}=.*/b2sums_${arch}=('${deb_sum}')/" \
    "$pkgbuild_src" >"$build/pkg/PKGBUILD"
  # Fail loudly if the PKGBUILD layout drifted and the substitutions silently missed.
  grep -qx "pkgver=${version}" "$build/pkg/PKGBUILD"
  grep -qF "b2sums_${arch}=('${deb_sum}')" "$build/pkg/PKGBUILD"
  grep -qF "b2sums=('${license_sum}')" "$build/pkg/PKGBUILD"

  conf="$build/makepkg.conf"
  {
    echo "source /etc/makepkg.conf"
    echo "CARCH='${arch}'"
    echo "CHOST='${arch}-pc-linux-gnu'"
    echo "PKGDEST='${pkgdest}'"
    echo "SRCDEST='${srcdest}'"
    echo "BUILDDIR='${build}/builddir'"
    echo "PKGEXT='.pkg.tar.zst'"
    echo "GPGKEY='${gpgkey}'"
  } >"$conf"

  makepkg_args=(--config "$conf" --force --cleanbuild --nodeps --noconfirm)
  if [[ -n "$gpgkey" ]]; then
    makepkg_args+=(--sign --key "$gpgkey")
  fi
  echo "==> makepkg for $arch"
  (cd "$build/pkg" && env -u CARCH -u CHOST -u PKGDEST -u SRCDEST -u SRCPKGDEST -u LOGDEST \
    -u BUILDDIR -u PKGEXT -u GPGKEY makepkg "${makepkg_args[@]}")

  pkgfile="orca-ide-${version}-${pkgrel}-${arch}.pkg.tar.zst"
  if [[ ! -f "$pkgdest/$pkgfile" ]]; then
    echo "error: expected $pkgdest/$pkgfile, got:" >&2
    ls -la "$pkgdest" >&2
    exit 1
  fi
  if ! bsdtar -xOf "$pkgdest/$pkgfile" .PKGINFO | grep -qx "arch = ${arch}"; then
    echo "error: $pkgfile .PKGINFO does not declare arch = ${arch}" >&2
    exit 1
  fi

  repo="$out_root/$arch"
  rm -rf "$repo"
  mkdir -p "$repo"
  cp "$pkgdest/$pkgfile" "$repo/"
  if [[ -n "$gpgkey" ]]; then
    cp "$pkgdest/$pkgfile.sig" "$repo/"
  fi

  repo_add_args=()
  if [[ -n "$gpgkey" ]]; then
    repo_add_args+=(--sign --key "$gpgkey")
  fi
  repo-add "${repo_add_args[@]}" "$repo/orca.db.tar.zst" "$repo/$pkgfile"

  # Why: repo-add makes orca.db/orca.files symlinks; GitHub release assets cannot be symlinks,
  # so publish real copies under the names pacman requests and drop the duplicates.
  for db in db files; do
    rm -f "$repo/orca.$db" "$repo/orca.$db.sig"
    cp "$repo/orca.$db.tar.zst" "$repo/orca.$db"
    if [[ -n "$gpgkey" ]]; then
      cp "$repo/orca.$db.tar.zst.sig" "$repo/orca.$db.sig"
    fi
    rm -f "$repo/orca.$db.tar.zst" "$repo/orca.$db.tar.zst.sig" "$repo/orca.$db.tar.zst.old" \
      "$repo/orca.$db.tar.zst.old.sig"
  done

  if [[ -n "$gpgkey" ]]; then
    gpg --batch --armor --export "$gpgkey" >"$repo/orca-arch-key.asc"
  fi
  echo "${version}-${pkgrel}" >"$repo/VERSION"
done

echo
echo "==> Built Orca pacman repo ${version}-${pkgrel} in $out_root ($([[ -n "$gpgkey" ]] && echo signed || echo UNSIGNED))"
for arch in $arches; do
  (cd "$out_root/$arch" && for f in *; do printf '  %-10s %-55s %s\n' "$arch" "$f" "$(du -h "$f" | cut -f1)"; done)
done
