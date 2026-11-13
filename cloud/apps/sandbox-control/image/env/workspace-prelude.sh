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
#   The clone is blobless (--filter=blob:none): history and trees, file contents only for the
#   checkout. A full clone of a large repo (stablyai/orca, ~2.7 GB) outran the 120 s start timeout.
#   With ORCA_CLONE_BACKGROUND=1 the clone runs detached after this script returns, so orcad starts
#   at once; it reports through $CLONE_DIR (state: running | done | failed <reason>, plus git's
#   --progress output) and the control plane's GET /v1/sandboxes/:id/clone reads it.
set -uo pipefail
P=/vercel/sandbox/project
ROOT=/vercel/sandbox/repos
CLONE_DIR="$HOME/.orca-sandbox/clone"
# A stuck clone fails with a reason instead of hanging forever.
CLONE_TIMEOUT_S="${ORCA_CLONE_TIMEOUT_S:-900}"
export GIT_TERMINAL_PROMPT=0
auth=()
if [ -n "${ORCA_GIT_EXTRAHEADER:-}" ]; then
  auth=(-c "http.https://github.com/.extraheader=$ORCA_GIT_EXTRAHEADER")
fi
ref="${ORCA_REPO_REF:-}"

first_commit() {
  if ! git -C "$P" rev-parse --verify --quiet HEAD >/dev/null; then
    git -C "$P" checkout --quiet -B "${ref:-main}" 2>/dev/null || true
    git -C "$P" -c user.name='Orca' -c user.email='noreply@orca.dev' \
      commit --quiet --allow-empty -m 'Initial commit' && echo 'Empty repository: created a first commit.'
  fi
}

# Clones into $P (which may already exist, empty). Progress goes to stderr.
clone_repo() {
  local opts=(--filter=blob:none --progress) status
  timeout "$CLONE_TIMEOUT_S" git ${auth[@]+"${auth[@]}"} clone "${opts[@]}" ${ref:+--branch "$ref"} -- "$ORCA_REPO_URL" "$P"
  status=$?
  if [ "$status" -ne 0 ]; then
    [ "$status" -eq 124 ] && return 124
    # Empty it in place: the start script must keep seeing the directory, or it would clone itself.
    find "$P" -mindepth 1 -delete 2>/dev/null || true
    # Branch missing (or a repo with no commits): clone the default branch, then switch.
    timeout "$CLONE_TIMEOUT_S" git ${auth[@]+"${auth[@]}"} clone "${opts[@]}" -- "$ORCA_REPO_URL" "$P" || return "$?"
    if [ -n "$ref" ] && ! git -C "$P" checkout --quiet "$ref" -- 2>/dev/null; then
      git -C "$P" checkout --quiet -b "$ref" -- || true
    fi
  fi
  first_commit
}

# The reason the control plane shows: never the raw log (it may echo URLs).
clone_failure_reason() {
  local status="$1" log="$2"
  if [ "$status" -eq 124 ]; then
    echo 'clone_timeout'
  elif grep -qiE 'could not read Username|authentication failed|repository not found|403|denied' "$log" 2>/dev/null; then
    echo 'repo_unreachable'
  elif grep -qiE 'no space left' "$log" 2>/dev/null; then
    echo 'disk_full'
  else
    echo 'clone_failed'
  fi
}


# Brings a prebuilt checkout (environment build) up to date: fetches only what changed on the target
# branch (ORCA_REPO_REF, else the build's branch) and checks it out. A branch the remote doesn't have
# yet (a new workspace branch) starts from the build's branch, freshly fetched. Progress goes to stderr.
update_repo() {
  local base target status
  base="$(git -C "$P" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  target="${ref:-$base}"
  [ -n "$target" ] || return 0
  timeout "$CLONE_TIMEOUT_S" git ${auth[@]+"${auth[@]}"} -C "$P" fetch --progress origin "+refs/heads/$target:refs/remotes/origin/$target"
  status=$?
  if [ "$status" -eq 0 ]; then
    # -f: the install may have rewritten tracked files (a lockfile); the branch's version wins.
    git -C "$P" checkout --quiet -f -B "$target" "origin/$target" --
    return $?
  fi
  [ "$status" -eq 124 ] && return 124
  { [ -n "$base" ] && [ "$base" != "$target" ]; } || return "$status"
  timeout "$CLONE_TIMEOUT_S" git ${auth[@]+"${auth[@]}"} -C "$P" fetch --progress origin "+refs/heads/$base:refs/remotes/origin/$base" || return $?
  git -C "$P" checkout --quiet -f -B "$target" "origin/$base" --
}

# Runs clone_repo or update_repo detached (own session, no inherited stdio), so the start command
# returns while it runs; $CLONE_DIR/state reads running, then done or "failed <reason>".
run_detached() {
  echo running >"$CLONE_DIR/state"
  : >"$CLONE_DIR/progress.log"
  export -f clone_repo update_repo first_commit clone_failure_reason
  export P CLONE_DIR CLONE_TIMEOUT_S ORCA_REPO_URL ref
  export ORCA_PRELUDE_AUTH="${ORCA_GIT_EXTRAHEADER:-}" ORCA_PRELUDE_STEP="$1"
  setsid bash -c '
    auth=()
    [ -n "$ORCA_PRELUDE_AUTH" ] && auth=(-c "http.https://github.com/.extraheader=$ORCA_PRELUDE_AUTH")
    unset ORCA_PRELUDE_AUTH
    "$ORCA_PRELUDE_STEP" >>"$CLONE_DIR/progress.log" 2>&1
    status=$?
    if [ "$status" -eq 0 ]; then
      echo done >"$CLONE_DIR/state.next"
    elif [ "$ORCA_PRELUDE_STEP" = update_repo ]; then
      # Not fatal: the build'"'"'s checkout is there, just older. The status says so; the create goes on.
      echo "done stale" >"$CLONE_DIR/state.next"
    else
      echo "failed $(clone_failure_reason "$status" "$CLONE_DIR/progress.log")" >"$CLONE_DIR/state.next"
    fi
    mv -f "$CLONE_DIR/state.next" "$CLONE_DIR/state"
  ' </dev/null >/dev/null 2>&1 &
}

if [ ! -e "$P" ] && [ -n "${ORCA_ENV_REPO_DIR:-}" ] && [ -d "$ROOT/$ORCA_ENV_REPO_DIR/.git" ]; then
  ln -s "$ROOT/$ORCA_ENV_REPO_DIR" "$P"
  if [ "${ORCA_CLONE_BACKGROUND:-}" = 1 ]; then
    # The desktop shows this as "Update repository" (GET /v1/sandboxes/:id/clone): fetch what changed
    # since the build, in the background. A failure leaves the build's commit, which still opens.
    mkdir -p "$CLONE_DIR"
    run_detached update_repo
  elif [ -n "$ref" ] && [ "$(git -C "$P" symbolic-ref --quiet --short HEAD 2>/dev/null)" != "$ref" ]; then
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
  mkdir -p "$P" "$CLONE_DIR"
  if [ "${ORCA_CLONE_BACKGROUND:-}" = 1 ]; then
    run_detached clone_repo
  else
    clone_repo 2>"$CLONE_DIR/progress.log" || exit 1
  fi
fi
exit 0
