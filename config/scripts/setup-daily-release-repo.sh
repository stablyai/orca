#!/usr/bin/env bash
# Provision stablyai/orca-daily for daily-mac-build.yml. Keep daily cuts out of hourly’s 72-entry retention window.
# Reuse hourly’s App credentials; this only widens its installation.
# Run once after setup-hourly-release-token.sh: bash config/scripts/setup-daily-release-repo.sh
#
set -euo pipefail

ORG="stablyai"
DAILY_REPO="$ORG/orca-daily"
MAIN_REPO="$ORG/orca"
APP_SLUG="orca-hourly-release"

fail() {
  echo "error: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || fail "gh CLI not found. See https://cli.github.com"
gh auth status >/dev/null 2>&1 || fail "Not logged in. Run: gh auth login"

if gh api "repos/$DAILY_REPO" --jq '.full_name' >/dev/null 2>&1; then
  echo "$DAILY_REPO already exists."
else
  echo "Creating $DAILY_REPO..."
  # Updaters fetch assets unauthenticated, so keep this public. Disable unwatched non-release features.
  # --add-readme supplies the commit required to create a release tag in a new repo.
  gh repo create "$DAILY_REPO" \
    --public \
    --description "Daily macOS dev builds of Orca, cut from main each morning. Not a source repo." \
    --add-readme \
    --disable-issues \
    --disable-wiki ||
    fail "Could not create $DAILY_REPO."
fi

# Also checked outside the create branch: a repo made before --add-readme is here.
if ! gh api "repos/$DAILY_REPO/commits" --jq 'length' >/dev/null 2>&1; then
  fail "$DAILY_REPO has no commits — releases cannot be tagged. Add any file to it first."
fi

echo
echo "Granting $APP_SLUG access to $DAILY_REPO..."

# Org owners can widen the installation via API; other admins get a 403 and manual instructions.
INSTALL_ID="$(gh api "orgs/$ORG/installations" --paginate \
  --jq ".installations[] | select(.app_slug == \"$APP_SLUG\") | .id" 2>/dev/null || true)"
REPO_ID="$(gh api "repos/$DAILY_REPO" --jq '.id' 2>/dev/null || true)"

GRANTED=false
if [[ -n "$INSTALL_ID" && -n "$REPO_ID" ]]; then
  if gh api -X PUT "user/installations/$INSTALL_ID/repositories/$REPO_ID" >/dev/null 2>&1; then
    GRANTED=true
    echo "Done — $APP_SLUG can now write to $DAILY_REPO."
  fi
fi

if [[ "$GRANTED" != "true" ]]; then
  # Ordinary gh auth tokens cannot query App repository access; use the smoke test rather than claim verification.
  cat <<EOF

Could not do it from here${INSTALL_ID:+ (needs an Organization Owner)}. Do it in the browser:

  1. Open:  https://github.com/organizations/$ORG/settings/installations
  2. Configure  ->  $APP_SLUG
  3. Repository access  ->  Only select repositories  ->  add $DAILY_REPO
     (keep orca-hourly and orca-adhoc selected; all dev channels use this one App)
  4. Save.
EOF
fi

echo
echo "Smoke-test the pipeline (after this merges):"
echo "  gh workflow run daily-mac-build.yml --repo $MAIN_REPO -f force=true"
echo "  gh run watch --repo $MAIN_REPO"
