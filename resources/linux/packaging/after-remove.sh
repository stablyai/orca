#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into an Orca install dir — never delete an unrelated
# /usr/bin/orca-ide a user or other package may own.
set -e

link="/usr/bin/orca-ide"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/Orca/*|/opt/orca-ide/*|/opt/orca/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
