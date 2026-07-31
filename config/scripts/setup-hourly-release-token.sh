#!/usr/bin/env bash
#
# Provisions HOURLY_RELEASE_TOKEN, the secret hourly-mac-build.yml uses to publish
# into stablyai/orca-hourly. GITHUB_TOKEN cannot be used: it is scoped to the repo
# running the workflow, and hourly artifacts are published to a different one.
#
# The token is read silently and never leaves this process except into `gh secret
# set` over a pipe. It is never echoed, never passed as a command-line argument
# (argv is world-readable via `ps`), and never written to disk or shell history.
#
# Usage:  bash config/scripts/setup-hourly-release-token.sh
#
set -euo pipefail

# Guard: xtrace would echo the token to stderr on every expansion.
set +x
if [[ -o xtrace ]]; then
  echo "Refusing to run with xtrace enabled; it would echo the token." >&2
  exit 1
fi

MAIN_REPO="stablyai/orca"
HOURLY_REPO="stablyai/orca-hourly"
SECRET_NAME="HOURLY_RELEASE_TOKEN"

TOKEN=""
# Scrub on every exit path, including Ctrl-C and failures.
cleanup() {
  TOKEN=""
  unset TOKEN
}
trap cleanup EXIT INT TERM

fail() {
  echo "error: $*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || fail "gh CLI not found. See https://cli.github.com"
gh auth status >/dev/null 2>&1 || fail "Not logged in. Run: gh auth login"

# Setting a repo secret requires admin; check before asking for a token.
if [[ "$(gh api "repos/$MAIN_REPO" --jq '.permissions.admin' 2>/dev/null)" != "true" ]]; then
  fail "You need admin on $MAIN_REPO to set repository secrets."
fi
gh api "repos/$HOURLY_REPO" --jq '.full_name' >/dev/null 2>&1 ||
  fail "$HOURLY_REPO does not exist or you cannot see it."

cat <<EOF

Create a fine-grained personal access token
───────────────────────────────────────────
  1. Open:  https://github.com/settings/personal-access-tokens/new
  2. Resource owner ........  stablyai
  3. Repository access .....  Only select repositories  →  $HOURLY_REPO
  4. Permissions ...........  Repository permissions  →  Contents: Read and write
  5. Expiration ............  set a reminder; the hourly build breaks silently
                              when this lapses
  6. Generate, then paste it below.

Grant nothing beyond Contents on $HOURLY_REPO. This token only needs to cut
releases and prune old ones. It is never given access to $MAIN_REPO.

EOF

# -s: no echo. -r: no backslash mangling. Prefer the controlling terminal over
# stdin so a piped invocation cannot silently consume something else as the token.
#
# Why open /dev/tty rather than test it: `[[ -r /dev/tty ]]` passes on a mode
# check even where there is no controlling terminal to attach to, so the read
# then fails and the script would fall through having set nothing.
if { exec 3</dev/tty; } 2>/dev/null; then
  read -rsp "Paste token (input hidden): " TOKEN <&3 || fail "Could not read the token."
  exec 3<&-
elif [[ -t 0 ]]; then
  read -rsp "Paste token (input hidden): " TOKEN || fail "Could not read the token."
else
  fail "No terminal available to read the token without echoing it.
Run this script directly in a terminal, not through a pipe or an agent."
fi
echo

[[ -n "$TOKEN" ]] || fail "No token entered."

# Pass via env, never argv: command-line arguments are visible to any local user
# through `ps`, environment of a child process is not.
echo "Verifying token..."
token_login="$(GH_TOKEN="$TOKEN" gh api user --jq '.login' 2>/dev/null)" ||
  fail "Token rejected by GitHub. Check that you copied it completely."
echo "  authenticates as: $token_login"

# Prove Contents:write for real rather than trusting the checkbox — a draft
# release is invisible in the releases atom feed, so this cannot disturb users.
echo "Verifying write access to $HOURLY_REPO..."
probe_tag="setup-probe-$(date -u +%Y%m%d%H%M%S)"
probe_id="$(GH_TOKEN="$TOKEN" gh api -X POST "repos/$HOURLY_REPO/releases" \
  -f tag_name="$probe_tag" -F draft=true \
  -f name="token setup probe (safe to ignore)" --jq '.id' 2>/dev/null)" ||
  fail "Token cannot create releases in $HOURLY_REPO. Re-check: Contents = Read and write, repository = $HOURLY_REPO."

if ! GH_TOKEN="$TOKEN" gh api -X DELETE "repos/$HOURLY_REPO/releases/$probe_id" >/dev/null 2>&1; then
  echo "  warning: could not delete probe draft release $probe_id; remove it manually." >&2
else
  echo "  create + delete release: ok"
fi

# Piped on stdin, so the value never appears in argv or in shell history.
echo "Storing $SECRET_NAME in $MAIN_REPO..."
printf '%s' "$TOKEN" | gh secret set "$SECRET_NAME" --repo "$MAIN_REPO" ||
  fail "Could not set the secret."

cleanup

echo
echo "Done. $SECRET_NAME is set on $MAIN_REPO."
echo
echo "Smoke-test the pipeline without waiting for the hour:"
echo "  gh workflow run hourly-mac-build.yml --repo $MAIN_REPO -f force=true"
echo "  gh run watch --repo $MAIN_REPO"
