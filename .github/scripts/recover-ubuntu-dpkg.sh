#!/usr/bin/env bash
set -euo pipefail

# A timed-out apt frontend can leave dpkg running in a separate session.
sudo timeout --kill-after=10s 30 bash -euo pipefail -c '
  while lslocks --noheadings --raw --notruncate --output PATH | grep -E "^/var/lib/dpkg/lock(-frontend)?$" >/dev/null; do
    sleep 1
  done
  dpkg --configure -a
'
