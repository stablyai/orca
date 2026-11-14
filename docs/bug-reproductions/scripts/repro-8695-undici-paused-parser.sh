#!/usr/bin/env bash
# Issue #8695 — undici 7.28.0 paused-parser assert (process crash).
#
# Runs the minimal net-server + fetch(without body consume) repro against:
#   1) system node (if present)
#   2) production Orca Electron as node (ELECTRON_RUN_AS_NODE=1)
#
# Expected: AssertionError assert(!this.paused) in Parser.finish / non-zero exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EVIDENCE_DIR="$ROOT/docs/bug-reproductions/evidence"
mkdir -p "$EVIDENCE_DIR"
OUT="$EVIDENCE_DIR/8695-undici-repro.log"
REPRO_JS="$(mktemp -t orca-undici-repro.XXXXXX.js)"
trap 'rm -f "$REPRO_JS"' EXIT

cat >"$REPRO_JS" <<'EOF'
const { createServer } = require("node:net");

const body = Buffer.alloc(64 * 1024, 0x61);

const server = createServer((socket) => {
  socket.once("data", () => {
    socket.write(
      "HTTP/1.1 200 OK\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Connection: close\r\n\r\n",
    );
    socket.write(body);
    socket.end();
  });
});

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    setTimeout(() => {
      console.log("Unexpected: process did not crash");
      server.close();
      process.exit(0);
    }, 500);
  } catch (e) {
    console.error("fetch error", e);
    server.close();
    process.exit(2);
  }
});
EOF

{
  echo "=== #8695 undici paused-parser repro $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo "node: $(node -v 2>/dev/null || echo missing)"
  echo

  echo "--- system node ---"
  set +e
  node "$REPRO_JS" 2>&1
  sys_ec=$?
  set -e
  echo "system node exit: $sys_ec"
  echo

  ORCA_BIN="${ORCA_ELECTRON_BIN:-/Applications/Orca.app/Contents/MacOS/Orca}"
  echo "--- Orca Electron as node ($ORCA_BIN) ---"
  if [[ -x "$ORCA_BIN" ]]; then
    set +e
    ELECTRON_RUN_AS_NODE=1 "$ORCA_BIN" "$REPRO_JS" 2>&1
    orca_ec=$?
    set -e
    echo "orca exit: $orca_ec"
  else
    echo "Orca binary missing: $ORCA_BIN"
    orca_ec=127
  fi

  echo
  if [[ "${sys_ec:-0}" -ne 0 || "${orca_ec:-0}" -ne 0 ]]; then
    echo "RESULT: REPRODUCED (process crashed or non-zero exit as expected)"
    exit 0
  fi
  echo "RESULT: NOT REPRODUCED (both runtimes survived)"
  exit 1
} | tee "$OUT"
