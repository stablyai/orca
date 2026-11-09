#!/usr/bin/env bash
# Installed by Orca environment builds as the repo's post-checkout hook. When git creates a new linked
# worktree (`git worktree add` passes the null commit as the previous HEAD), give it the dependency
# folders the build installed in the primary checkout, as hard links: near-instant, real paths (not
# symlinks, so bundlers and native modules behave). Hard links share file contents: tools that rewrite
# a file in place inside these folders change it for every worktree on this VM (one workspace per VM).
# Any post-checkout hook the repo already had runs afterwards, unchanged.
prev="${1:-}"
here="$(dirname "$0")"
if [ "$prev" = "0000000000000000000000000000000000000000" ] && [ "${ORCA_SKIP_DEPS_LINK:-}" != 1 ]; then
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  primary="$(dirname "$common")"
  list="$common/orca-env-deps"
  if [ -n "$top" ] && [ "$top" != "$primary" ] && [ -f "$list" ]; then
    started=$(date +%s%N)
    linked=0
    while IFS= read -r rel; do
      case "$rel" in '' | /* | *..*) continue ;; esac
      [ -e "$primary/$rel" ] && [ ! -e "$top/$rel" ] || continue
      mkdir -p "$(dirname "$top/$rel")"
      if [ -d "$primary/$rel" ]; then
        if ! cp -al -- "$primary/$rel" "$top/$rel" 2>/dev/null; then
          # A partial hard-link copy would make the fallback nest inside it: start clean.
          rm -rf -- "$top/$rel"
          cp -a -- "$primary/$rel" "$top/$rel" 2>/dev/null || { rm -rf -- "$top/$rel"; continue; }
        fi
      else
        cp -a -- "$primary/$rel" "$top/$rel" 2>/dev/null || continue
      fi
      linked=$((linked + 1))
    done <"$list"
    if [ "$linked" -gt 0 ]; then
      echo "Orca: reused $linked installed dependency folder(s) from the environment build ($(( ($(date +%s%N) - started) / 1000000 )) ms)." >&2
    fi
  fi
fi
if [ -x "$here/post-checkout.orca-chained" ]; then
  if head -n 1 "$here/post-checkout.orca-chained" | grep -Eq '^#!.*(ba|da|z)?sh'; then
    # Sourced, so $0 still names `post-checkout` (husky v9 finds the user's hook by basename "$0").
    ( . "$here/post-checkout.orca-chained" "$@" )
    exit $?
  fi
  exec "$here/post-checkout.orca-chained" "$@"
fi
exit 0
