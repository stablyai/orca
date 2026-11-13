#!/usr/bin/env bash
set -euo pipefail

# Change repository locations while retaining suites, architectures and signing keys.
for source in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  if [ -f "$source" ]; then
    sudo sed -i -E \
      -e 's#https?://(azure\.archive|archive|security)\.ubuntu\.com/ubuntu#https://mirrors.mit.edu/ubuntu#g' \
      -e 's#https?://ports\.ubuntu\.com/ubuntu-ports#https://mirrors.mit.edu/ubuntu-ports#g' \
      "$source"
  fi
done
