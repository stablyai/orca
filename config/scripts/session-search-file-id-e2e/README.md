# Windows session-search file-ID integration reproduction

Opt-in Windows/NTFS harness for #20551. Run from the fix workspace root with
dependencies, the Electron binary, and Git object `9845bef63a6` available.
Everything generated stays under ignored `notes/search-ipc/`; each run gets fresh
roots and a profile. No real transcripts, WSL discovery, desktop windows, or user
profile are used. The synthetic file is recreated until NTFS assigns a real inode
above `Number.MAX_SAFE_INTEGER`; failure to obtain one fails the test.

```powershell
$env:ORCA_BACKGROUND_LAUNCH='1'
pnpm exec esbuild config/scripts/session-search-file-id-e2e/run.ts --bundle --platform=node --format=esm --packages=external --outfile=notes/search-ipc/run.mjs
node notes/search-ipc/run.mjs red
# Expected exit 1: initial indexing/query succeeds, subsequent reconciliation fails.
node notes/search-ipc/run.mjs green
# Expected exit 0 for both the lifecycle and fresh-host restart phases.
node config/scripts/session-search-file-id-e2e/verify.cjs
```

Run red and green sequentially: their build step reuses the exported source tree.
The verifier checks the expected red failure, green reports, identical oracle
expressions after formatting normalization, and that exactly the two file-ID
SELECT source files differ. It does not turn an arbitrary red failure into success.

## Exact topology

The runner exports **LOCAL integration overlay** #20516 head
`9845bef63a6d0b80ec37af82b5b275287b8e17df` with `git archive`, then bundles the real
scanner entry and parent modules with esbuild. It does not check out, stage, or
push overlay sources. Green changes only the two SELECT projections to the CAST
expressions in #20551; red retains the original projections. CLI #20514 is unused.

An isolated, windowless Electron host installs the production child search
enablement using fixture settings. The production shared scanner client invokes
`spawnAiVaultServiceProcess`, which forks Electron with `ELECTRON_RUN_AS_NODE=1`
and the real `session-scanner-service-entry`. That child owns the production
instance, indexer, SQLite search engine, and IPC request handling.

Marker queries come from **separate Node client processes over a real Windows
named pipe**, through production `UnixSocketTransport`, production `RpcDispatcher`
and `AI_VAULT_METHODS`, then the search registry/service and scanner IPC. Status
polls and default-off/disabled responses also exercise registered handlers directly.
An independent read-only SQLite connection verifies active FTS rows and committed
file metadata against filesystem size/mtime. The transcript-consumer observation
logs actual replace/append modes without supplying messages or search results.

Labelled fixture seams, identical in both variants:

- Parent root resolution returns the existing `isolatedScanRoots` fixture.
- `getSettings` supplies the isolated JSON policy; real enablement/settings-change functions apply it.
- The child's allowlisted environment includes `ORCA_BACKGROUND_LAUNCH=1`.
- Passive child PID, IPC, stderr, and transcript-read observations are added.
- The unused default RPC method catalog is excluded; the dispatcher receives the production `AI_VAULT_METHODS` explicitly. Its runtime context supplies only a fixture runtime ID.

## Oracle and evidence

Default-off creates no DB and returns disabled. Enablement indexes the marker;
two **real default 20-second recent timer cycles** and two explicit full passes
preserve it. An append becomes searchable; a rename replacement with equal byte
length and exactly restored mtime removes the old marker and adds the new one.
The scanner restarts, then a second Electron host opens the same profile/DB and
queries again. Disablement followed by an append, explicit reconcile, and 21-second
wait leaves the DB unchanged and the new marker absent.

`red-latest.json` / `green-latest.json` locate each run. Reports contain parent and
scanner PIDs, executable/Node/Electron versions, IPC events, raw unsafe inode,
queries, DB metadata, read modes, and scanner exit codes. `*-stages.jsonl` gives
live progress; `process-*.log` preserves complete output. `comparison.json` records
the two-source-only comparison. The production scanner shutdown protocol closes
only recorded children; the runner waits for its own Electron hosts and external
clients. Profiles/DBs remain as evidence, not running services.

## Boundaries not exercised

This is not a packaged/full Orca desktop launch. The host and scanner are bundled
from production sources by this harness, not electron-vite's complete app build.
The actual runtime authentication/metadata server, CLI routing, remote SSH/relay
transport, and UI are not exercised. Named-pipe framing and dispatcher are real,
but the harness connects them directly with a fixture token; it makes no claim
about production authentication. No session-search UI exists in this topology.
