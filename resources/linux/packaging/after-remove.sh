#!/bin/bash
# Remove only links installed by this package.
set -e

# RPM passes an instance count; dpkg passes the package lifecycle action.
case "${1-}" in
  0 | remove | purge) ;;
  *) exit 0 ;;
esac

for name in orca-ide orca-commander-handoff; do
  link="/usr/bin/$name"
  [ -L "$link" ] || continue
  target="$(readlink "$link" || true)"
  case "$target" in
    "/opt/Orca/resources/bin/$name"|"/opt/orca-ide/resources/bin/$name"|"/opt/orca/resources/bin/$name")
      rm -f "$link"
      ;;
  esac
done

exit 0
