#!/usr/bin/env bash
# Needs bash 4+ (mapfile); on macOS use Homebrew bash.
# Mirror Orca release assets from GitHub Releases to the public R2 bucket
# served at https://downloads.orca.dev. orca.dev's "Download started" page
# offers these as an opt-in "mirror link" for when GitHub returns 5xx.
# Run by .github/workflows/release-mirror-r2.yml after each published release.
#
# Usage:
#   mirror-release-to-r2.sh                 # latest desktop release, website assets
#   mirror-release-to-r2.sh v1.4.254        # a specific desktop tag
#   mirror-release-to-r2.sh mobile-android-v0.0.64 app-release.apk
#   ALL_ASSETS=1 mirror-release-to-r2.sh    # every asset except sourcemaps
#
# Layout written to the bucket:
#   releases/<tag>/<asset>       immutable, versioned copy
#   latest/<asset>               stable desktop tags (vX.Y.Z) only — what the mirror link points at
#   android/latest/<asset>       mobile-android-v* tags only
#   latest/release.json          {tag, mirroredAt, assets[]} for the desktop alias
#
# Requires: gh (authenticated), curl, jq, and an uploader:
#   - aws CLI + R2 S3 keys (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY): preferred,
#     multipart uploads, no size limit. Create keys in Cloudflare dashboard →
#     R2 → Manage API tokens (Object Read & Write on orca-downloads).
#   - otherwise wrangler (authenticated), which caps each file at 300 MiB.
# Downloads are retried aggressively and resumed, and every file is checked
# against the size and sha256 digest GitHub reports before upload.

set -euo pipefail

REPO="${REPO:-stablyai/orca}"
BUCKET="${BUCKET:-orca-downloads}"
PUBLIC_BASE="${PUBLIC_BASE:-https://downloads.orca.dev}"
WEBSITE_ASSETS=(orca-macos-arm64.dmg orca-macos-x64.dmg orca-windows-setup.exe orca-linux.AppImage)
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-57e6ddd3bb755dbf8e8dc7ff557e9014}"
R2_ENDPOINT="https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"
# wrangler r2 object put caps single uploads at 300 MiB; the S3 path has no such cap.
WRANGLER_MAX_BYTES=$((300 * 1024 * 1024))
if [[ -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  UPLOADER="s3"
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
  # Newer aws CLIs send extra default checksums R2 has rejected; only send them when required.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
else
  UPLOADER="wrangler"
fi

log() { printf '[mirror] %s\n' "$*" >&2; }

# Retry any command with backoff: GitHub's 504s come and go.
retry() {
  local attempts="$1"; shift
  local n=1 delay=3
  until "$@"; do
    if (( n >= attempts )); then log "giving up after $n attempts: $*"; return 1; fi
    log "attempt $n failed, retrying in ${delay}s: $*"
    sleep "$delay"; n=$((n + 1)); delay=$(( delay < 60 ? delay * 2 : 60 ))
  done
}

TAG="${1:-}"
shift || true
REQUESTED_ASSETS=("$@")

if [[ -z "$TAG" ]]; then
  TAG="$(retry 10 gh api "repos/$REPO/releases/latest" --jq .tag_name)"
fi
log "release: $TAG (uploading via $UPLOADER)"

RELEASE_JSON="$(retry 10 gh api "repos/$REPO/releases/tags/$TAG")"

if (( ${#REQUESTED_ASSETS[@]} == 0 )); then
  if [[ "${ALL_ASSETS:-0}" == "1" ]]; then
    mapfile -t REQUESTED_ASSETS < <(jq -r '.assets[].name | select(startswith("orca-sourcemaps") | not)' <<<"$RELEASE_JSON")
  elif [[ "$TAG" == v* ]]; then
    REQUESTED_ASSETS=("${WEBSITE_ASSETS[@]}")
  else
    mapfile -t REQUESTED_ASSETS < <(jq -r '.assets[].name' <<<"$RELEASE_JSON")
  fi
fi

# Why: GitHub's /releases/latest skips RCs, so an RC must never move latest/.
if [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  ALIAS_PREFIX="latest"
elif [[ "$TAG" == mobile-android-v* ]]; then
  ALIAS_PREFIX="android/latest"
else
  ALIAS_PREFIX=""
fi

WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/orca-release-mirror/$TAG}"
mkdir -p "$WORK_DIR"
log "working dir: $WORK_DIR"

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

content_type_for() {
  case "$1" in
    *.dmg) echo "application/x-apple-diskimage" ;;
    *.exe) echo "application/vnd.microsoft.portable-executable" ;;
    *.apk) echo "application/vnd.android.package-archive" ;;
    *.yml) echo "text/yaml" ;;
    *.json) echo "application/json" ;;
    *.zip) echo "application/zip" ;;
    *.deb) echo "application/vnd.debian.binary-package" ;;
    *.rpm) echo "application/x-rpm" ;;
    *) echo "application/octet-stream" ;;
  esac
}

verify() {
  local file="$1" size="$2" digest="$3"
  [[ -f "$file" ]] || return 1
  local actual_size
  actual_size="$(wc -c <"$file" | tr -d ' ')"
  [[ "$actual_size" == "$size" ]] || { log "size mismatch for $file: $actual_size != $size"; return 1; }
  if [[ "$digest" == sha256:* ]]; then
    [[ "$(sha256_of "$file")" == "${digest#sha256:}" ]] || { log "sha256 mismatch for $file"; return 1; }
  fi
}

download() {
  local url="$1" out="$2" size="$3" digest="$4"
  # -C - resumes partial downloads; a corrupt partial is discarded and refetched.
  curl -fL --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
    -H "Accept: application/octet-stream" -C - -o "$out" "$url" || true
  verify "$out" "$size" "$digest" && return 0
  rm -f "$out"
  return 1
}

upload() {
  local file="$1" key="$2" cache="$3" type="$4"
  local disposition
  disposition="attachment; filename=\"$(basename "$file")\""
  if [[ "$UPLOADER" == "s3" ]]; then
    # aws s3 cp switches to multipart above the threshold, so file size is unbounded.
    retry 5 aws s3 cp "$file" "s3://$BUCKET/$key" --endpoint-url "$R2_ENDPOINT" \
      --content-type "$type" --cache-control "$cache" --content-disposition "$disposition" \
      --only-show-errors
  else
    retry 5 wrangler r2 object put "$BUCKET/$key" --remote --file "$file" \
      --content-type "$type" --cache-control "$cache" --content-disposition "$disposition" >/dev/null
  fi
  log "uploaded $PUBLIC_BASE/$key"
}

MIRRORED=()
for name in "${REQUESTED_ASSETS[@]}"; do
  asset="$(jq -c --arg n "$name" '.assets[] | select(.name == $n)' <<<"$RELEASE_JSON")"
  if [[ -z "$asset" ]]; then log "asset not in $TAG: $name"; exit 1; fi
  size="$(jq -r .size <<<"$asset")"
  digest="$(jq -r '.digest // ""' <<<"$asset")"
  url="https://github.com/$REPO/releases/download/$TAG/$name"
  out="$WORK_DIR/$name"

  if [[ "$UPLOADER" == "wrangler" ]] && (( size > WRANGLER_MAX_BYTES )); then
    log "$name is $size bytes, over wrangler's 300 MiB limit — set R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY to upload via S3 multipart"
    exit 1
  fi

  if verify "$out" "$size" "$digest" 2>/dev/null; then
    log "already downloaded: $name"
  else
    log "downloading $name ($size bytes)"
    retry 10 download "$url" "$out" "$size" "$digest"
  fi

  type="$(content_type_for "$name")"
  upload "$out" "releases/$TAG/$name" "public, max-age=31536000, immutable" "$type"
  if [[ -n "$ALIAS_PREFIX" ]]; then
    # Short TTL so the alias moves to the next release quickly.
    upload "$out" "$ALIAS_PREFIX/$name" "public, max-age=300" "$type"
  fi
  MIRRORED+=("$name")
done

if [[ -n "$ALIAS_PREFIX" ]]; then
  manifest="$WORK_DIR/release.json"
  jq -n --arg tag "$TAG" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{tag: $tag, mirroredAt: $at, assets: $ARGS.positional}' --args "${MIRRORED[@]}" >"$manifest"
  upload "$manifest" "$ALIAS_PREFIX/release.json" "public, max-age=60" application/json
fi

log "done: ${#MIRRORED[@]} assets from $TAG"
