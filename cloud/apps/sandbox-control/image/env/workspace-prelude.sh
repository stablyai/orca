#!/usr/bin/env bash
# Runs right before orca-sandbox-start on a workspace's first boot. Prints only to stderr: the start
# script's last stdout line is the orcad recipe line the control plane parses.
#
# - Booted from an environment build (ORCA_ENV_REPO_DIR set): the repo is already cloned with its
#   dependencies installed under /vercel/sandbox/repos. Link it as the project (a link, not a move,
#   so absolute paths baked into installed dependencies keep working). No fetch when the build is
#   already on the requested branch: Orca fetches the base right before it adds the workspace's
#   worktree, so a fetch here would only delay orcad (measured ~0.5-1 s). Another branch is fetched
#   and checked out; if that fails the workspace still opens at the build's commit.
# - Otherwise clone ORCA_REPO_URL here so a repo with no commits yet also opens: it gets an empty
#   first commit on the requested branch, which Orca needs to create the workspace's worktree.
# - No repo at all (the user chose "Start empty"): a fresh repository with that same first commit.
set -uo pipefail
P=/vercel/sandbox/project
ROOT=/vercel/sandbox/repos
export GIT_TERMINAL_PROMPT=0
auth=()
if [ -n "${ORCA_GIT_EXTRAHEADER:-}" ]; then
  auth=(-c "http.https://github.com/.extraheader=$ORCA_GIT_EXTRAHEADER")
fi
ref="${ORCA_REPO_REF:-}"

first_commit() {
  if ! git -C "$P" rev-parse --verify --quiet HEAD >/dev/null; then
    git -C "$P" checkout --quiet -B "${ref:-main}" 2>/dev/null || true
    git -C "$P" -c user.name='Orca' -c user.email='cloud@onorca.dev' \
      commit --quiet --allow-empty -m 'Initial commit' && echo 'Empty repository: created a first commit.'
  fi
}

if [ ! -e "$P" ] && [ -n "${ORCA_ENV_REPO_DIR:-}" ] && [ -d "$ROOT/$ORCA_ENV_REPO_DIR/.git" ]; then
  ln -s "$ROOT/$ORCA_ENV_REPO_DIR" "$P"
  if [ -n "$ref" ] && [ "$(git -C "$P" symbolic-ref --quiet --short HEAD 2>/dev/null)" != "$ref" ]; then
    if timeout 60 git "${auth[@]}" -C "$P" fetch --quiet origin "+refs/heads/$ref:refs/remotes/origin/$ref"; then
      # -f: the install may have rewritten tracked files (a lockfile); the branch's version wins.
      git -C "$P" checkout --quiet -f -B "$ref" "origin/$ref" -- ||
        echo "Could not switch to $ref; the workspace starts at the build's commit."
    else
      echo "Could not fetch $ref; the workspace starts at the build's commit."
    fi
  fi
  first_commit
elif [ ! -e "$P" ] && [ -n "${ORCA_REPO_URL:-}" ]; then
  if ! git "${auth[@]}" clone --quiet ${ref:+--branch "$ref"} -- "$ORCA_REPO_URL" "$P" 2>/dev/null; then
    rm -rf -- "$P"
    # Branch missing (or a repo with no commits): clone the default branch, then switch.
    git "${auth[@]}" clone --quiet -- "$ORCA_REPO_URL" "$P" || exit 1
    if [ -n "$ref" ] && ! git -C "$P" checkout --quiet "$ref" -- 2>/dev/null; then
      git -C "$P" checkout --quiet -b "$ref" -- || true
    fi
  fi
  first_commit
elif [ ! -e "$P" ]; then
  git init --quiet "$P" || exit 1
  first_commit
fi
exit 0
