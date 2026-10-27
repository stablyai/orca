#!/bin/sh
# Portable entry point; install/vendor test_gate.py beside this file.
set -eu
exec python3 "$(dirname "$0")/test_gate.py" "$@"
