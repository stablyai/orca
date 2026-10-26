#!/bin/bash
# Remove only our install-owned symlink; preserve any unrelated /usr/bin/orca-ide.
set -e

# RPM passes an instance count; dpkg passes the package lifecycle action.
case "${1-}" in
  0 | remove | purge) ;;
  *) exit 0 ;;
esac

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
