#!/usr/bin/env bash
# Environment build ("Cloud Computer"), run by the control plane in a VM booted from the golden image.
# Clones every repo, runs the org's install script once with `set -euo pipefail`, then records what it
# built from (commit + lockfile blob ids per repo) so the control plane can tell when a rebuild is due.
# Everything printed here streams live to the desktop build log.
#
# Env from the control plane (validated there): ORCA_BUILD_REPOS (`<url>|<branch or empty>|<dir>|
# <git auth header or empty>` lines: each private repo gets its own placeholder the egress swaps), ORCA_INSTALL_SCRIPT_B64, ORCA_LOCKFILES (space list), optional ORCA_GIT_EXTRAHEADER and ORCA_CLONE_FILTER, plus
# ORCA_BUILD_SECRET_NAMES (space list of the team secrets the environment names; each value rides in
# the variable of that name) and ORCA_BUILD_WITHHELD_SECRETS (names it lists that builds never get).
# `::orca-step:: <name>` lines mark progress.
# Exit codes: 10 clone, 20 install script, 30 recording the result, 40 a secret's value left on disk.
set -uo pipefail
umask 022
# One stream: the provider replays stdout and stderr separately after the fact, so a failed build's
# log would read out of order. `::orca-error::` lines carry Orca's own failure explanations.
exec 2>&1
OUT=/tmp/orca-build
ROOT=/vercel/sandbox/repos
mkdir -p "$OUT" "$ROOT"

# SEC-2: the snapshot of this VM is the team's saved environment, booted by every member's workspace,
# so a secret's value must never be in it. Secrets are for the install script alone: take_secrets
# moves them out of this script's environment (clones and Orca's own steps never see them), the
# install step hands them to that one child, and scan_secrets searches the disk before the build
# may succeed.
secret_names=()
secret_values=()
take_secrets() {
  local name
  for name in ${ORCA_BUILD_SECRET_NAMES:-}; do
    case "$name" in '' | *[!A-Z0-9_]* | [0-9]* | ORCA_* | PATH | HOME | LD_* | DYLD_*) continue ;; esac
    [ -n "${!name:-}" ] || continue
    secret_names+=("$name")
    secret_values+=("${!name}")
    unset "$name"
  done
  unset ORCA_BUILD_SECRET_NAMES
  # Only a file that changes after this marker can hold a value: the base image never saw one.
  : >"$OUT/.scan-since"
}

# Fails (non-zero) when a secret's value is in a file the build created or changed, anywhere on the
# disk the snapshot captures. Plain text only: a value the script encoded, encrypted or compressed is
# not found, and neither is one shorter than 8 characters (it would match ordinary text). A search
# that cannot run fails too. Prints names and paths, never a value.
# ORCA_SCAN_ROOT: tests only (a scratch tree); the control plane never sets it.
scan_secrets() {
  [ "${#secret_names[@]}" -gt 0 ] || return 0
  local root="${ORCA_SCAN_ROOT:-/}" i line pattern hit named=0
  local names=() patterns=() args=() newer=() sudo=()
  for i in "${!secret_names[@]}"; do
    # grep -F reads a newline as "or": a multi-line value (a PEM key) is searched by its longest line.
    pattern=""
    while IFS= read -r line; do
      case "$line" in -----*) continue ;; esac
      if [ "${#line}" -gt "${#pattern}" ]; then pattern="$line"; fi
    done < <(printf '%s\n' "${secret_values[$i]}") # a pipe, not a here-string temp file
    [ "${#pattern}" -ge 8 ] || continue
    names+=("${secret_names[$i]}")
    patterns+=("$pattern")
    args+=(-e "$pattern")
  done
  [ "${#patterns[@]}" -gt 0 ] || return 0
  if ! command -v find >/dev/null 2>&1 || ! command -v grep >/dev/null 2>&1 || ! command -v xargs >/dev/null 2>&1; then
    echo "::orca-error:: Orca couldn’t check the build for secrets, so the environment wasn’t saved."
    return 1
  fi
  # Root-owned files count too (`sudo npm config set` writes /root/.npmrc).
  if sudo -n true 2>/dev/null; then sudo=(sudo -n); fi
  # A missing marker (the install script removed it) means every file is searched.
  if [ -f "$OUT/.scan-since" ]; then newer=(-cnewer "$OUT/.scan-since"); fi
  changed_files() {
    ${sudo[@]+"${sudo[@]}"} find "$root" \( -path /proc -o -path /sys -o -path /dev -o -path /run \) -prune \
      -o -type f ${newer[@]+"${newer[@]}"} -print0 2>/dev/null
  }
  # One pass for every value; the per-secret passes only run on a build that is about to fail.
  if [ -z "$(changed_files | ${sudo[@]+"${sudo[@]}"} xargs -0 grep -lsF "${args[@]}" -- 2>/dev/null | head -n 1)" ]; then
    return 0
  fi
  for i in "${!names[@]}"; do
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      named=1
      echo "::orca-error:: ${names[$i]} was left in $hit. Saved environments are shared with your team, so remove it before the install script ends."
    done < <(changed_files | ${sudo[@]+"${sudo[@]}"} xargs -0 grep -lsF -e "${patterns[$i]}" -- 2>/dev/null | head -n 5)
  done
  if [ "$named" -eq 0 ]; then
    # The file moved between the two passes: still a build that held a value on disk.
    echo "::orca-error:: The install script left a secret on disk, so the environment wasn’t saved. Remove it before the script ends, then save again."
  fi
  return 1
}

take_secrets
step() { printf '\n::orca-step:: %s\n' "$1"; }
started=$(date +%s)
export PATH="/opt/orca/tools/bin:/opt/orca/bin:$PATH"
export ORCA_REPOS_ROOT="$ROOT" ORCA_ENVIRONMENT_BUILD=1 CI=1 GIT_TERMINAL_PROMPT=0
repos() { printf '%s\n' "$ORCA_BUILD_REPOS"; }

# Tell the script author (often an agent) what they are installing onto.
pm=$(for c in apt-get dnf yum apk; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; break; }; done)
echo "Base image: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"), $(nproc) vCPU, package manager: ${pm:-none} (with sudo)"

step clone
first=""
while IFS='|' read -r url branch dir header; do
  [ -n "$url" ] || continue
  dest="$ROOT/$dir"
  [ -n "$first" ] || first="$dest"
  # The egress layer swaps the placeholder for a short-lived repo token; nothing real is on disk,
  # and the header is never written to the repo's config.
  git_auth=()
  [ -z "${header:-}" ] || git_auth=(-c "http.https://github.com/.extraheader=$header")
  echo "Cloning $url${branch:+ ($branch)}"
  rm -rf -- "$dest"
  # The clone's own error shows only when it really failed (an empty repo is recovered below).
  # ORCA_CLONE_FILTER (automatic environments: blob:none) keeps history and trees, not every old blob.
  if ! git "${git_auth[@]}" clone --quiet ${ORCA_CLONE_FILTER:+--filter="$ORCA_CLONE_FILTER"} ${branch:+--branch "$branch"} -- "$url" "$dest" 2>"$OUT/clone.err"; then
    refs=0
    git "${git_auth[@]}" ls-remote --exit-code -- "$url" >/dev/null 2>&1 || refs=$?
    if [ -n "$branch" ] && [ "$refs" -eq 2 ]; then
      # Reachable but no refs at all (ls-remote exits 2): a repo with no commits yet.
      echo "$url has no commits yet; starting it empty on $branch."
      rm -rf -- "$dest"
      { git "${git_auth[@]}" clone --quiet -- "$url" "$dest" 2>/dev/null && git -C "$dest" checkout --quiet -b "$branch"; } || exit 10
    else
      cat "$OUT/clone.err"
      echo "::orca-error:: Could not clone $url${branch:+ at $branch}. Check that the branch exists and Orca Cloud can reach the repository." 
      exit 10
    fi
  fi
  git -C "$dest" log -1 --format='  at %h %s' 2>/dev/null || echo '  (no commits yet)'
done < <(repos)

step install
printf '%s' "${ORCA_INSTALL_SCRIPT_B64:-}" | base64 -d >"$OUT/install.sh"
if [ -s "$OUT/install.sh" ]; then
  echo "Running the install script in ${first:-$ROOT}"
  for name in ${ORCA_BUILD_WITHHELD_SECRETS:-}; do
    echo "$name is a model key, so environment builds don’t get it. Agents in workspaces still do."
  done
  (
    cd "${first:-$ROOT}" || exit 1
    if [ "${#secret_names[@]}" -gt 0 ]; then
      for i in "${!secret_names[@]}"; do export "${secret_names[$i]}=${secret_values[$i]}"; done
    fi
    exec bash -euo pipefail "$OUT/install.sh"
  ) </dev/null
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "::orca-error:: The install script exited with status $rc." 
    exit 20
  fi
else
  echo "No install script; the build keeps the cloned repos."
fi

step record
scan_secrets || exit 40
secret_values=()
# New workspaces are linked worktrees of these checkouts: list the dependency folders the install
# produced and add a post-checkout hook that hard-links them into each new worktree.
# Python virtualenvs are left out on purpose: their scripts and editable installs embed the primary
# checkout's absolute path, so a linked copy would run the wrong source.
deps_re='(^|/)(node_modules|vendor/bundle|\.bundle|bower_components|\.yarn/cache|\.pnpm-store)/?$|(^|/)\.env[^/]*$'
while IFS='|' read -r url branch dir _; do
  [ -n "$url" ] || continue
  dest="$ROOT/$dir"
  common="$(git -C "$dest" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || continue
  git -C "$dest" ls-files --others --ignored --exclude-standard --directory 2>/dev/null \
    | sed 's#/$##' | grep -E "$deps_re" | head -n 500 >"$common/orca-env-deps" || true
  if [ -n "${ORCA_DEPS_HOOK_B64:-}" ]; then
    # A relative core.hooksPath (husky: .husky/_) names a gitignored folder a new worktree lacks; pin
    # it to the primary checkout so every worktree runs the same hooks, ours included.
    rel="$(git -C "$dest" config --get core.hooksPath 2>/dev/null || true)"
    case "$rel" in '' | /*) ;; *) git -C "$dest" config core.hooksPath "$dest/$rel" ;; esac
    hooks="$(git -C "$dest" rev-parse --path-format=absolute --git-path hooks)"
    mkdir -p "$hooks"
    if [ -e "$hooks/post-checkout" ] && ! grep -q 'orca-env-deps' "$hooks/post-checkout"; then
      mv -- "$hooks/post-checkout" "$hooks/post-checkout.orca-chained"
    fi
    printf '%s' "$ORCA_DEPS_HOOK_B64" | base64 -d >"$hooks/post-checkout" && chmod 0755 "$hooks/post-checkout"
  fi
  n=$(wc -l <"$common/orca-env-deps" | tr -d ' ')
  [ "$n" -gt 0 ] && echo "$dir: $n installed folder(s) carried into new workspaces."
done < <(repos)
{
  printf '{"durationSec":%d,"repos":[' "$(( $(date +%s) - started ))"
  sep=""
  while IFS='|' read -r url branch dir _; do
    [ -n "$url" ] || continue
    dest="$ROOT/$dir"
    commit=$(git -C "$dest" rev-parse --verify --quiet HEAD 2>/dev/null || true)
    head=$(git -C "$dest" symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    printf '%s{"url":"%s","dir":"%s","branch":"%s","commit":"%s","lockfiles":{' "$sep" "$url" "$dir" "$head" "$commit"
    lsep=""
    if [ -n "$commit" ]; then
      for f in ${ORCA_LOCKFILES:-}; do
        blob=$(git -C "$dest" rev-parse --verify --quiet "HEAD:$f" 2>/dev/null || true)
        if [ -n "$blob" ]; then printf '%s"%s":"%s"' "$lsep" "$f" "$blob"; lsep=","; fi
      done
    fi
    printf '}}'
    sep=","
  done < <(repos)
  printf '],"diskUsedBytes":%s,"diskTotalBytes":%s}\n' \
    "$(df -B1 --output=used / | tail -n 1 | tr -d ' ')" "$(df -B1 --output=size / | tail -n 1 | tr -d ' ')"
} >"$OUT/result.json" || exit 30
# Nothing from this VM's own session belongs in the image, only what the script installed.
rm -rf -- "$OUT/install.sh" "$OUT/.scan-since" "$HOME/.bash_history" "$HOME/.orcad-data" "$HOME/.orca-sandbox"
echo "Disk used: $(df -h --output=used / | tail -n 1 | tr -d ' ') of $(df -h --output=size / | tail -n 1 | tr -d ' ')"
