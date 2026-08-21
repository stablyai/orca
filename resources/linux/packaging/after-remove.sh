#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into an MCode install dir — never delete an unrelated
# /usr/bin/mcode-ide a user or other package may own.
set -e

link="/usr/bin/mcode-ide"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/MCode/*|/opt/mcode-ide/*|/opt/mcode/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
