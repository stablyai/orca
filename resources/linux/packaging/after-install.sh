#!/bin/bash
# deb/rpm must register orca-ide for headless hosts where the in-app installer cannot run.
# The shim resolves the app relative to itself, so a symlink works; discover the install directory
# because electron-builder sanitizes productName.
set -e

is_owned_link() {
  local link="$1" name="$2"
  [ -L "$link" ] || return 1
  local link_target candidate candidate_target
  link_target="$(readlink -f -- "$link" 2>/dev/null || true)"
  for candidate in "/opt/Orca/resources/bin/$name" "/opt/orca-ide/resources/bin/$name" "/opt/orca/resources/bin/$name"; do
    candidate_target="$(readlink -f -- "$candidate" 2>/dev/null || true)"
    if [ -n "$candidate_target" ] && [ "$link_target" = "$candidate_target" ]; then
      return 0
    fi
  done
  return 1
}

for dir in /opt/Orca /opt/orca-ide /opt/orca; do
  sandbox="$dir/chrome-sandbox"
  if [ -f "$sandbox" ]; then
    # Why: packaged Linux installs must leave Chromium's sandbox helper usable
    # on hosts where unprivileged user namespaces are unavailable.
    chmod 4755 "$sandbox" || true
  fi

  if [ -x "$dir/resources/bin/orca-ide" ]; then
    for name in orca-ide orca-commander-handoff; do
      shim="$dir/resources/bin/$name"
      link="/usr/bin/$name"
      [ -x "$shim" ] || continue
      if [ -e "$link" ] || [ -L "$link" ]; then
        is_owned_link "$link" "$name" || continue
      fi
      ln -sfn -- "$shim" "$link"
    done
    break
  fi
done

exit 0
