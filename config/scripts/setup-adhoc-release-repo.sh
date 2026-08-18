#!/usr/bin/env bash
#
# Creates stablyai/orca-adhoc and grants the existing release App write access to
# it, so adhoc-mac-build.yml can publish there.
#
# Why a separate repo rather than reusing orca-hourly: an adhoc build is somebody's
# unlanded branch. Sharing hourly's repo would put branch builds in the list a
# developer riding main sees, and the two are different levels of unvetted.
#
# Why no secrets are set here: the adhoc workflow reuses the same GitHub App as
# hourly — one App id, one private key, one thing to rotate. This script only has
# to widen that App's installation to cover the new repo.
#
# Run once, after config/scripts/setup-hourly-release-token.sh:
#   bash config/scripts/setup-adhoc-release-repo.sh
#
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
  # Why public: the in-app updater fetches release assets unauthenticated, exactly
  # as it does for orca-hourly. A private repo would 404 for every client.
  #
  # Why the features are off: this repo holds releases and nothing else. Leaving
  # issues open invites bug reports against a branch build in a repo nobody
  # watches, where they are simply lost.
  #
  # Why --add-readme in a repo with no source: publishing a release creates a tag,
  # and a tag needs a commit. Empty repo = "Repository is empty" 25 minutes in.
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

# Why attempt the API before printing instructions: an org owner can do this in
# one call. Everyone else gets a 403 and the manual path below — GitHub does not
# let a mere admin widen an App's repository selection.
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
  # Why no automated check afterwards: the endpoints that report an App's
  # repository access (repos/*/installation, user/installations/*/repositories)
  # both reject an ordinary `gh auth login` token, so any "verified" this script
  # printed would be guesswork. The smoke test below is the real check.
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
