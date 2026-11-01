#!/usr/bin/env bash
# Provision the org-owned, non-expiring App key for hourly/adhoc/daily releases; GITHUB_TOKEN cannot publish cross-repo.
# setup-{adhoc,daily}-release-repo.sh widen the installation. Read the key file directly into gh secret set’s stdin,
# never echoing it, exposing it in argv, or copying it to disk.
# Usage: bash config/scripts/setup-hourly-release-token.sh [path/to/key.pem]
#
set -euo pipefail

# Check xtrace before disabling it; otherwise the guard misses key exposure.
if [[ -o xtrace ]]; then
  echo "Refusing to run with xtrace enabled; it would echo the private key." >&2
  exit 1
fi
set +x

MAIN_REPO="stablyai/orca"
HOURLY_REPO="stablyai/orca-hourly"
APP_ID_SECRET="HOURLY_RELEASE_APP_ID"
APP_KEY_SECRET="HOURLY_RELEASE_APP_PRIVATE_KEY"

fail() {
  echo "error: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || fail "gh CLI not found. See https://cli.github.com"
gh auth status >/dev/null 2>&1 || fail "Not logged in. Run: gh auth login"

# Setting repo secrets requires admin; check before asking for anything.
if [[ "$(gh api "repos/$MAIN_REPO" --jq '.permissions.admin' 2>/dev/null)" != "true" ]]; then
  fail "You need admin on $MAIN_REPO to set repository secrets."
fi
gh api "repos/$HOURLY_REPO" --jq '.full_name' >/dev/null 2>&1 ||
  fail "$HOURLY_REPO does not exist or you cannot see it."

cat <<EOF

Create a GitHub App (one time — the key never expires)
──────────────────────────────────────────────────────
  1. Open:  https://github.com/organizations/stablyai/settings/apps/new
  2. Name ..................  orca-hourly-release
     Homepage URL ..........  https://github.com/$HOURLY_REPO
     Webhook ...............  UNCHECK "Active"
  3. Repository permissions  ->  Contents: Read and write
     (leave everything else alone)
  4. "Where can this app be installed?"  ->  Only on this account
  5. Create, then note the App ID shown at the top of the page.
  6. Generate a private key (bottom of the page) — a .pem downloads.
  7. Install App  ->  Only select repositories  ->  $HOURLY_REPO

EOF

read -rp "App ID (numeric): " APP_ID
[[ "$APP_ID" =~ ^[0-9]+$ ]] || fail "App ID must be numeric, got: ${APP_ID:-<empty>}"

KEY_PATH="${1:-}"
if [[ -z "$KEY_PATH" ]]; then
  read -rp "Path to the downloaded .pem: " KEY_PATH
fi
# Expand a leading ~ so a pasted path works without quoting rules.
KEY_PATH="${KEY_PATH/#\~/$HOME}"
[[ -r "$KEY_PATH" ]] || fail "Cannot read key file: $KEY_PATH"
grep -q "BEGIN.*PRIVATE KEY" "$KEY_PATH" ||
  fail "$KEY_PATH does not look like a PEM private key."

echo "Storing $APP_ID_SECRET in $MAIN_REPO..."
printf '%s' "$APP_ID" | gh secret set "$APP_ID_SECRET" --repo "$MAIN_REPO" ||
  fail "Could not set $APP_ID_SECRET."

# Piped on stdin so the key never appears in argv or in shell history.
echo "Storing $APP_KEY_SECRET in $MAIN_REPO..."
gh secret set "$APP_KEY_SECRET" --repo "$MAIN_REPO" <"$KEY_PATH" ||
  fail "Could not set $APP_KEY_SECRET."

echo
echo "Done. Both secrets are set on $MAIN_REPO."
echo
echo "Delete your local copy of the key — the workflow reads it from the secret,"
echo "and a .pem sitting in ~/Downloads is a standing credential:"
echo "  rm '$KEY_PATH'"
echo
echo "Smoke-test the pipeline without waiting for the hour (after this merges):"
echo "  gh workflow run hourly-mac-build.yml --repo $MAIN_REPO -f force=true"
echo "  gh run watch --repo $MAIN_REPO"
