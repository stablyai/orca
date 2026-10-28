#!/usr/bin/env bash
# Provision stablyai/orca-adhoc for adhoc-mac-build.yml. Keep unlanded branch builds out of main’s hourly feed.
# Reuse hourly’s App credentials; this only widens its installation.
# Run once after setup-hourly-release-token.sh: bash config/scripts/setup-adhoc-release-repo.sh
set -euo pipefail

ORG="stablyai"
ADHOC_REPO="$ORG/orca-adhoc"
MAIN_REPO="$ORG/orca"
APP_SLUG="orca-hourly-release"

fail() {
  echo "error: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || fail "gh CLI not found. See https://cli.github.com"
gh auth status >/dev/null 2>&1 || fail "Not logged in. Run: gh auth login"

if gh api "repos/$ADHOC_REPO" --jq '.full_name' >/dev/null 2>&1; then
  echo "$ADHOC_REPO already exists."
else
  echo "Creating $ADHOC_REPO..."
  # Updaters fetch assets unauthenticated, so keep this public. Disable unwatched non-release features.
  # --add-readme supplies the commit required to create a release tag in a new repo.
  gh repo create "$ADHOC_REPO" \
    --public \
    --description "Adhoc macOS dev builds of Orca, cut from unlanded branches. Not a source repo." \
    --add-readme \
    --disable-issues \
    --disable-wiki ||
    fail "Could not create $ADHOC_REPO."
fi

# Also checked outside the create branch: a repo made before --add-readme is here.
if ! gh api "repos/$ADHOC_REPO/commits" --jq 'length' >/dev/null 2>&1; then
  fail "$ADHOC_REPO has no commits — releases cannot be tagged. Add any file to it first."
fi

echo
echo "Granting $APP_SLUG access to $ADHOC_REPO..."

# Org owners can widen the installation via API; other admins get a 403 and manual instructions.
INSTALL_ID="$(gh api "orgs/$ORG/installations" --paginate \
  --jq ".installations[] | select(.app_slug == \"$APP_SLUG\") | .id" 2>/dev/null || true)"
REPO_ID="$(gh api "repos/$ADHOC_REPO" --jq '.id' 2>/dev/null || true)"

GRANTED=false
if [[ -n "$INSTALL_ID" && -n "$REPO_ID" ]]; then
  if gh api -X PUT "user/installations/$INSTALL_ID/repositories/$REPO_ID" >/dev/null 2>&1; then
    GRANTED=true
    echo "Done — $APP_SLUG can now write to $ADHOC_REPO."
  fi
fi

if [[ "$GRANTED" != "true" ]]; then
  # Ordinary gh auth tokens cannot query App repository access; use the smoke test rather than claim verification.
  cat <<EOF

Could not do it from here${INSTALL_ID:+ (needs an Organization Owner)}. Do it in the browser:

  1. Open:  https://github.com/organizations/$ORG/settings/installations
  2. Configure  ->  $APP_SLUG
  3. Repository access  ->  Only select repositories  ->  add $ADHOC_REPO
     (keep orca-hourly/orca-daily selected; all dev channels use this one App)
  4. Save.
EOF
fi

echo
echo "Smoke-test the pipeline (after this merges):"
echo "  gh workflow run adhoc-mac-build.yml --repo $MAIN_REPO --ref main \\"
echo "    -f ref=<your-branch> -f label=<short-name>"
echo "  gh run watch --repo $MAIN_REPO"
