# Design: Agent Hook Endpoint Discovery via On-Disk File

## Problem

Agent status is not reported in the dashboard after an Orca restart when the user reattaches to a terminal that was created by the previous Orca instance.

### Repro

1. `pn dev` → Orca starts. Hook server binds a random loopback port and mints a UUID token.
2. User opens a terminal pane → the PTY is spawned with `ORCA_AGENT_HOOK_PORT` / `ORCA_AGENT_HOOK_TOKEN` / `ORCA_AGENT_HOOK_ENV` / `ORCA_AGENT_HOOK_VERSION` in its env.
3. User runs a Claude / Codex / Gemini / OpenCode session → hooks fire, status shows up in the dashboard.
4. User kills Orca. The hook server stops; the port is released; the token is discarded.
5. `pn dev` again → new Orca. Hook server binds a **different** port and mints a **different** token.
6. User reattaches to the surviving terminal and runs the agent again → no status shows up.

### Why

The installed hook scripts (`src/main/{claude,codex,gemini}/hook-service.ts` — `getManagedScript()`) correctly read `$ORCA_AGENT_HOOK_PORT` and `$ORCA_AGENT_HOOK_TOKEN` from the shell environment at invocation time — nothing is baked in. The problem is that the **shell's environment was frozen when the PTY was first spawned**, and nothing updates it when Orca restarts with new coordinates. The hook's `curl` POSTs to a dead port with a stale token; the new server (different port, different token) never receives the event.

This manifests in two surviving-PTY situations:

- **Daemon PTY mode** (`src/main/ipc/pty.ts:360` intentionally preserves daemon sessions across app quit).
- **Child processes of any PTY** — e.g., a long-running `claude` session that was started before the current Orca — the child inherited the PTY's env once at `fork()`, so even if the PTY itself were re-spawned, already-running agent processes would still have stale values.

SSH PTYs are **not** in scope. `src/main/ipc/pty.ts:407` deliberately suppresses hook env injection for remote connections because the hook server is bound to the Orca host's loopback and the token is a local bearer credential that must not leave the host. SSH sessions never reported agent status before this fix and will not after it.

A non-obvious consequence: the bug is invisible on a fresh terminal created *after* the restart (it gets the new env), but silent on any surviving terminal. Users can easily believe the feature is flaky rather than structurally broken.

## Goals

1. Once a user is running a post-fix Orca **and** has reinstalled hooks at least once on that build, surviving host-local PTYs (and their child agent processes) deliver hook events successfully across any subsequent Orca restart without user action. See "Migration gap" below for the one-time upgrade caveat.
2. Survive crashes — not just clean shutdowns — so a user who force-quits Orca and reopens it does not lose reporting on reattach.
3. Keep working across multiple Orca instances running simultaneously (e.g., a dev build and a packaged build) — each instance only receives its own hooks.
4. Backward-compatible with existing installed hook scripts and existing PTY env; the upgrade is silent for any PTY spawned *after* the user starts the post-fix Orca.
5. No new daemons, no network changes, no new IPC channels.

### Migration gap (explicit non-goal)

The design does **not** retroactively fix the combination of a pre-fix hook script and a pre-fix PTY. If both predate the upgrade, the PTY has stale `PORT`/`TOKEN` in env *and* the hook script lacks the source-if-present step, so there is nothing that reaches the new server. This situation resolves as soon as either end is refreshed:

- **New PTY under post-fix Orca** — picks up `ORCA_AGENT_HOOK_ENDPOINT` plus current `PORT`/`TOKEN`, and (assuming the user has also reinstalled hooks) the script sources the file. Fix engages.
- **Hook reinstall from Settings on post-fix Orca** — the upgraded script sources the file even from a surviving pre-fix PTY, so already-running shells start working the next time they fire a hook.

The existing server-side throttled version-mismatch warning (`normalizeHookPayload`, `warnedVersions`) will log once per stale version received, which is how a user with a pre-fix install discovers that they need to reinstall. Auto-reinstall on mismatch is explicitly out of scope — it would overwrite user-customized `settings.json` blocks (Claude, Codex, Gemini) without consent and deserves its own design review.

## Non-Goals

- **Remote (SSH) agent status reporting.** SSH PTYs deliberately receive no hook env today (see `src/main/ipc/pty.ts:407`): the hook server binds to the Orca host's loopback and the token is a local bearer credential. An endpoint file cannot change this — even with the path in env, the remote shell cannot read a file on the Orca host. Making SSH report agent status is a separate problem (remote-reachable endpoint, different threat model, different transport) and needs its own design.
- Refactoring the transport away from HTTP loopback. A Unix-domain-socket variant was considered (sidestep port churn entirely) but requires a Windows strategy (named pipes) and changes the server, the hook scripts, and the test harness. Out of scope.
- Pushing env updates into surviving shells (`export ORCA_AGENT_HOOK_*=...` via PTY stdin). Races with user typing, pollutes shell history, doesn't help if the user is already inside an agent process.

## Proposed Solution: On-Disk Endpoint File

Decouple the hook client (shell script) from the shell's frozen env by keeping the **current** server coordinates in a file on disk. Orca rewrites the file on every `start()`. Hook scripts read it at invocation time, so they always reach the live server even if the PTY env is stale.

### Data flow

```
Orca start:
  agentHookServer.start() →
    1. mint or reuse token (see "Token lifetime" below)
    2. listen(0, 127.0.0.1) → new port
    3. write endpoint file atomically:
         ORCA_AGENT_HOOK_PORT=<port>
         ORCA_AGENT_HOOK_TOKEN=<token>
         ORCA_AGENT_HOOK_ENV=<env>
         ORCA_AGENT_HOOK_VERSION=<protocolVersion>

PTY spawn (any time after start):
  buildPtyEnv() returns:
    ORCA_AGENT_HOOK_ENDPOINT=<endpoint file path>   ← new
    ORCA_AGENT_HOOK_PORT=<port>                     ← retained for back-compat
    ORCA_AGENT_HOOK_TOKEN=<token>                   ← retained for back-compat
    ORCA_AGENT_HOOK_ENV=<env>
    ORCA_AGENT_HOOK_VERSION=<protocolVersion>

Hook fires (sh):
  if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then
    . "$ORCA_AGENT_HOOK_ENDPOINT"   # sources PORT/TOKEN/ENV/VERSION fresh
  fi
  # else fall through to whatever env we already have

  curl ... http://127.0.0.1:$ORCA_AGENT_HOOK_PORT ... X-Orca-Agent-Hook-Token: $ORCA_AGENT_HOOK_TOKEN
```

(Windows uses the same keys written as `set KEY=VALUE` in `endpoint.cmd`; see §"File location and format" for the format details. The parse logic in §2b handles both shapes with one regex.)

The crucial property: **the file path is stable across restarts** (it's a function of the Orca install's userData directory), but the **contents are refreshed on every start**. A PTY stamped with the path by old-Orca still reads fresh coordinates from new-Orca.

### File location and format

Path: `${app.getPath('userData')}/agent-hooks/endpoint.env` on macOS / Linux, `endpoint.cmd` on Windows.

Format: shell-sourceable `KEY=VALUE` lines. This avoids a JSON parser dependency in the hook script (no `jq` on base macOS). On Windows, the same file is renamed `.cmd` and uses `set KEY=VALUE`; PowerShell can parse either without effort. Both shapes are parseable by a single regex with an optional `set\s+` prefix (see §2b), so the OpenCode plugin needs no platform detection.

```
# unix (endpoint.env)
ORCA_AGENT_HOOK_PORT=54321
ORCA_AGENT_HOOK_TOKEN=8f2c...
ORCA_AGENT_HOOK_ENV=development
ORCA_AGENT_HOOK_VERSION=1
```

```
# windows (endpoint.cmd)
set ORCA_AGENT_HOOK_PORT=54321
set ORCA_AGENT_HOOK_TOKEN=8f2c...
set ORCA_AGENT_HOOK_ENV=development
set ORCA_AGENT_HOOK_VERSION=1
```

Permissions: `0600` on POSIX. The token is a loopback bearer credential and must not be readable by other local users. (Parity with what PTY env already exposes via `/proc/<pid>/environ`, which is also owner-only on modern Linux.)

Atomicity: write to `endpoint.env.tmp` with `fs.writeFileSync(..., { mode: 0o600 })` then `fs.renameSync` to `endpoint.env`. Rename is atomic on the same filesystem; a hook reading concurrently either sees the old file or the new one, never a half-written one.

### Token lifetime

Keep today's behavior of minting a fresh UUID on every `start()`. We do **not** need to persist the token — the endpoint file decouples hooks from needing a stable token. A fresh token per instance is still a small defense-in-depth win (limits the blast radius of a token that leaks into, say, a shell history).

### Multi-instance safety (dev + prod)

Each install has its own `userData` directory (Electron convention), so each has its own `endpoint.env` path. A dev PTY is stamped with the dev path; a prod PTY is stamped with the prod path; neither reads the other. The existing `ORCA_AGENT_HOOK_ENV` cross-talk warning stays as belt-and-suspenders.

### Hook script changes

**POSIX (`sh`)** — prepend an optional source step before the existing body. Example for `src/main/claude/hook-service.ts` `getManagedScript()`:

```sh
#!/bin/sh
# Why: the endpoint file holds the *live* port/token for this Orca install.
# PTYs that survive an Orca restart have stale PORT/TOKEN baked into their
# env from the old instance — sourcing the file here lets us reach the new
# server. Falls back to PTY env if the file is missing (first-run / pre-2.x
# scripts / running outside Orca).
if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then
  . "$ORCA_AGENT_HOOK_ENDPOINT"
fi
if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then
  exit 0
fi
# ...rest unchanged...
```

**Windows (`.cmd` via `call`)** — the managed hook wrapper is a `.cmd` script, and the endpoint file is itself a `.cmd` script containing `set KEY=VALUE` lines. `call`ing it runs those `set` statements in the current cmd context, which is exactly the Windows analog of sourcing on POSIX — no PowerShell parser needed:

```
if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%"
```

No change to the HTTP transport, payload shape, or server routing.

### Bumping the protocol version

`ORCA_HOOK_PROTOCOL_VERSION` (`src/shared/agent-hook-types.ts`) bumped from `'1'` to `'2'` so the server's existing version-mismatch warning can distinguish pre-endpoint-file scripts from post-. That warning already exists and is already throttled — no new code, just a constant bump and the one-liner comment explaining what changed.

## Changes

### 1. `src/main/agent-hooks/server.ts` — Endpoint file lifecycle

**Add** a private method `writeEndpointFile()` that writes the four coordinates atomically with `0o600` permissions. Called at the end of `start()`, after `listen()` returns and `this.port` is populated. On failure (EACCES on userData, ENOSPC, etc.), log at `console.error` with the error message and fall through so `start()` still succeeds — the server remains usable via PTY env for freshly-spawned PTYs; only survivors lose the endpoint-file path. This is fail-open, matching the hook-payload failure-open policy already documented in `server.ts`.

**`stop()`** deliberately does NOT unlink the endpoint file. A stale file pointing at a dead port is the fail-open path (hook POSTs silently fail, same as pre-endpoint-file behavior). Unlinking would introduce a TOCTOU race: a concurrent Orca instance sharing userData could rewrite the file between our token check and unlink, and we would delete its live endpoint. The next successful `start()` overwrites the file atomically; orphan hygiene is handled by the tmp-file sweep inside `writeEndpointFile()`. The mode `0o600` on the file itself means there is no world-readable-cleanup urgency either.

**Modify** `buildPtyEnv()` to include `ORCA_AGENT_HOOK_ENDPOINT: <endpoint file path>` alongside the existing four variables. Keep the existing four for back-compat: a hook script that was installed before this change doesn't know to source the file, but still has (potentially stale) env to fall back on, and a hook script installed after the change will source the file first and then use the env as a fallback.

**`buildPtyEnv()` write-success gate**: `buildPtyEnv()` only sets `ORCA_AGENT_HOOK_ENDPOINT` when the **current** `start()`'s `writeEndpointFile()` call succeeded. If the current start's write failed (EACCES, ENOSPC, etc.), `buildPtyEnv()` omits `ORCA_AGENT_HOOK_ENDPOINT` entirely so hooks fall back to PTY env coords for *this* Orca only. Why: a stale file left over from a previous crashed instance would still exist on disk at the known path, and stamping freshly-spawned PTYs with that path would cause them to source *old* coords — worse than simply running without the endpoint file. The gate is an in-memory boolean on the server; it does not consult the filesystem.

**Export** the endpoint path from the server (read-only getter) so `buildPtyEnv` can include it without each caller needing to know the path convention.

**Safety invariants** (enforced in `writeEndpointFile()` and `start()`):

- **Shell-safe value validator**: every value written into the file must match `/^[A-Za-z0-9._:/-]+$/` before write. Values failing the check cause the whole write to abort (logged, fail-open — hooks fall back to PTY env). Why: on Windows, `call "%ORCA_AGENT_HOOK_ENDPOINT%"` executes the file as a `.cmd` script — an attacker-controlled value containing `&` or `^` could inject commands. On POSIX, `. "$ORCA_AGENT_HOOK_ENDPOINT"` is similarly sensitive to quoting. Restricting to a conservative character class eliminates the class of injection bugs and is easily wide enough for UUIDs, ports, env names, and version strings.
- **Directory mode `0o700` on POSIX**: `agent-hooks/` is created with `0o700` and re-chmod'd on every `start()` to catch a pre-existing directory with looser perms. Why: a token-bearing file needs its containing directory to also be owner-only or a local attacker can still enumerate/tamper at the directory level.
- **Orphan tmp-file sweep**: at the top of `start()`, list `agent-hooks/` and `unlink` any `.endpoint-<pid>-<uuid>.tmp` files older than 5 minutes. Why: a crash mid-write between `writeFileSync(tmp)` and `renameSync(tmp → final)` leaves an orphaned tmp file. Without a sweep, repeated crashes over months would accumulate hundreds of these.
- **Line endings**: CRLF on Windows, LF on POSIX. Why: some `cmd.exe` versions misparse `set KEY=VALUE` lines that end with a bare LF, producing values with trailing CR or silently ignoring the `set`. Matching the platform convention avoids the failure mode entirely.

### 2. `src/main/{claude,codex,cursor,gemini}/hook-service.ts` — Script body

Prepend the source-if-present step (see "Hook script changes" above) to the managed POSIX script in `getManagedScript()`. Add the equivalent `call`-based step — `if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%"` — to the Windows `.cmd` wrapper so the same `set KEY=VALUE` lines load into the cmd context.

### 2b. `src/main/opencode/hook-service.ts` — Plugin source

OpenCode is structurally the same bug: the plugin runs inside OpenCode's Node process, which was started under whichever Orca was alive at spawn time. `process.env.ORCA_AGENT_HOOK_PORT` is frozen at `fork()` — so a long-running OpenCode session started under old Orca posts to the dead port forever. OpenCode sessions tend to be long-lived, which makes this at least as user-visible as the shell-script case.

Change `getOpenCodePluginSource()` so `post()` (and only `post()`, since `getHookUrl()` is called from there) first attempts to read `ORCA_AGENT_HOOK_ENDPOINT` from env and — if present and readable — parses it for current `PORT`/`TOKEN`/`ENV`/`VERSION`, falling back to `process.env` otherwise.

**Stat-based cache** (not a plain read-every-post). `message.part.updated` fires many times per second during streaming, so a naive `readFileSync` per post would be a lot of redundant syscalls for a file that only changes on Orca restart. The plugin instead keeps a module-scope cache keyed by `mtimeMs + size + ino`:

1. On each `post()`, `fs.statSync(path)` the endpoint file (one syscall, much cheaper than read+parse).
2. Compute `cacheKey = ${stat.mtimeMs}:${stat.size}:${stat.ino}`. If it matches the last cached key, reuse the previously parsed object — no read, no parse.
3. On a cache miss, `readFileSync` + parse, then store `{ cacheKey, parsed }`.
4. On `statSync` failure (ENOENT, EACCES, etc.), **invalidate the cache** (`cacheKey = null`, `parsed = null`). Why: a transient stat failure must not lock in a stale parse — the next successful stat has to re-read. Without invalidation, a single flaky stat during an Orca restart could pin the plugin to the pre-restart coords for the lifetime of the OpenCode process.

Why `ino` is part of the cache key (not just mtime+size): the writer uses `renameSync(tmp → final)`, which allocates a fresh inode for the final file. Including `ino` means the cache invalidates on rename even when `mtimeMs` resolution is coarse (HFS+ is 1s, some network filesystems are worse) and even when the new file happens to have the same size as the old one. Rename-allocates-new-inode is the atomic-write primitive we already rely on; making it drive cache invalidation costs nothing.

Sketch (embedded in the plugin source string). A process-lifetime `let warnedBadEndpoint = false` guard is declared **inside the plugin source itself** (the plugin runs in OpenCode's process, not Orca's — it has no access to `server.ts` scope). This mirrors the *intent* of `server.ts`'s `warnedVersions` / `warnedEnvs` Sets (which are `const Set<string>` on the Orca side, not `let` booleans) but lives in a separate process:

```js
// Why: process-lifetime guard so a recurring parse error on a malformed
// endpoint file does not spam OpenCode's stderr once per hook post.
let warnedBadEndpoint = false;

// Why: message.part.updated fires many times/sec during streaming. Stat is
// much cheaper than read+parse; the file only changes across Orca restarts,
// which renameSync makes detectable via ino (fresh inode on every write).
let cacheKey = null;
let cacheParsed = null;

function readEndpointFile() {
  const fs = require('fs');
  const path = process.env.ORCA_AGENT_HOOK_ENDPOINT;
  if (!path) return null;
  let st;
  try {
    st = fs.statSync(path);
  } catch (err) {
    // Why: invalidate the cache on stat failure so a transient ENOENT/EACCES
    // during an Orca restart doesn't pin us to the pre-restart parsed coords.
    cacheKey = null;
    cacheParsed = null;
    if (err && err.code !== 'ENOENT' && !warnedBadEndpoint) {
      warnedBadEndpoint = true;
      console.warn('[orca-hook] failed to stat endpoint file:', err.message);
    }
    return null;
  }
  // Why: ino included because renameSync(tmp → final) allocates a fresh inode,
  // giving us a reliable invalidation signal even when mtimeMs resolution is
  // coarse (HFS+ 1s, some NFS worse) and the new file is the same size.
  const key = st.mtimeMs + ':' + st.size + ':' + st.ino;
  if (key === cacheKey && cacheParsed) return cacheParsed;
  try {
    const contents = fs.readFileSync(path, 'utf8');
    const out = {};
    for (const line of contents.split(/\r?\n/)) {
      // Why: Windows endpoint.cmd uses `set KEY=VALUE`; Unix endpoint.env uses
      // `KEY=VALUE`. Making `set ` optional lets the same parser handle both
      // without platform detection in the plugin. Digits are allowed in keys
      // to match the real ORCA_AGENT_HOOK_* namespace and remain future-proof.
      const m = line.match(/^(?:set\s+)?([A-Z0-9_]+)=(.*)$/);
      // Why: strip trailing CR so a CRLF-terminated Windows endpoint.cmd
      // parsed on POSIX (or vice versa) doesn't carry a '\r' into the value.
      if (m) out[m[1]] = m[2].replace(/\r$/, "");
    }
    cacheKey = key;
    cacheParsed = out;
    return out;
  } catch (err) {
    cacheKey = null;
    cacheParsed = null;
    // Why: warn once per process if the file exists but is unreadable/malformed
    // — a persistent, silently-swallowed parse error would otherwise leave the
    // plugin falling back to stale process.env on every post with no signal.
    if (err && err.code !== 'ENOENT' && !warnedBadEndpoint) {
      warnedBadEndpoint = true;
      console.warn('[orca-hook] failed to parse endpoint file:', err.message);
    }
    return null;
  }
}
```

`post()` consults the parsed file first for `ORCA_AGENT_HOOK_PORT` / `ORCA_AGENT_HOOK_TOKEN` / `ORCA_AGENT_HOOK_ENV` / `ORCA_AGENT_HOOK_VERSION`, falling back to `process.env.*` on any field the file didn't provide. Pane/tab/worktree identifiers stay on env (they are per-PTY, not per-Orca-instance).

### 3. `src/shared/agent-hook-types.ts` — Protocol version bump

Bumped `ORCA_HOOK_PROTOCOL_VERSION` from `'1'` → `'2'` (monotonic, no skipped version). The server already warns on mismatch, so users with stale installs see a clear, already-throttled diagnostic directing them to reinstall hooks.

### 4. `src/main/agent-hooks/server.test.ts` — Coverage

- `start()` writes endpoint file with correct permissions (POSIX-only assertion).
- `start()` → `stop()` → `start()` writes a *different* port but the file path is stable.
- `buildPtyEnv()` includes `ORCA_AGENT_HOOK_ENDPOINT` when the server is running and omits it when not.
- Endpoint file contents are re-parseable by `sh -c '. <file> && echo $ORCA_AGENT_HOOK_PORT'` (shell-integration smoke test — can stub if a shell is unavailable in CI).

### No changes needed

- **Renderer / IPC.** The dashboard doesn't care how hooks reach the server.
- **PTY spawn path.** `src/main/ipc/pty.ts` already calls `buildPtyEnv()` once at spawn time; it gets the extra `ORCA_AGENT_HOOK_ENDPOINT` variable for free.
- **Existing PTYs stamped before this change.** They have stale PORT/TOKEN but no ENDPOINT. That's fine:
  - If their installed hook script is *also* pre-change, behavior is unchanged (the original bug still happens for that one combination — can't fix a PTY-script pair that both predate the fix).
  - If the user reinstalls hooks from Settings after upgrading Orca, the script now sources the file on next hook fire; the env already has PORT/TOKEN but the file takes precedence, so stale env is effectively ignored. Bug resolved.
- **Security model.** Loopback + bearer token + 0600 file permissions. No regression from current env-based exposure.

## Behavior Matrix

| Scenario | Old behavior | New behavior |
|---|---|---|
| Fresh PTY, first Orca launch | Works | Works |
| Fresh PTY, Orca restarted (new PTY after restart) | Works | Works |
| Surviving daemon PTY after Orca restart | **Broken** (stale env) | Works (script sources fresh file) |
| Surviving SSH PTY after Orca restart | Never reported (by design) | Never reported (by design — out of scope, see Non-Goals) |
| Long-running `claude` child process after Orca restart | **Broken** (inherited stale env) | Works |
| Long-running OpenCode session after Orca restart | **Broken** (plugin reads frozen `process.env`) | Works (plugin reads endpoint file per post) |
| Dev Orca + prod Orca running simultaneously | Works (separate envs per PTY) | Works (separate files per install) |
| Force-quit Orca, relaunch | **Broken** for surviving PTYs | Works |
| Hook installed by old Orca, PTY spawned by new Orca | Works (PTY env fresh, old script reads env) | Works (same, plus file overrides if script is upgraded) |
| Hook installed by new Orca, PTY spawned by old Orca | N/A | Works only if the PTY is new (spawned by new Orca, which stamps `ORCA_AGENT_HOOK_ENDPOINT`). Old PTYs lack the endpoint env var and fall through to stale env coords from old Orca → dead port. This is the Migration gap already described above; explicit refresh requires a new PTY. |
| Hook installed by old Orca, PTY spawned by old Orca (upgrade transition) | Broken | Remains broken until user reinstalls hooks or spawns a new PTY — see "Migration gap" |

## Rejected Alternatives

**1. Persist port + token across restarts and reuse the same port.** Simpler (no hook script changes) but fragile: if the previously-held port has been claimed by another process between restarts, we fall back to a random port and the bug recurs. Also creates awkwardness if the user runs two Orca instances serially on the same userData (second one would fail to bind the saved port). File-based discovery is strictly more robust for the same marginal complexity.

**2. Re-push env updates into surviving shells via PTY stdin** (`printf 'export ORCA_AGENT_HOOK_PORT=%s\n' "$p"` written to each surviving PTY on startup). Races with whatever the user is typing. Pollutes shell history. Doesn't help child processes of the PTY — they inherit env at `fork()`, not from the parent shell's live env. Worst robustness of the three.

**3. Switch transport to a Unix domain socket at a fixed path** (e.g., `${userData}/agent-hooks/socket`). Avoids port churn entirely. Rejected because the Windows story (named pipe) requires a second transport implementation on both server and client, and `curl` on older Windows doesn't support `--unix-socket`. File-based discovery keeps the transport unchanged.

## Scope

- ~200 lines of production code added across `server.ts`, `{claude,codex,cursor,gemini}/hook-service.ts`, `opencode/hook-service.ts`, and `agent-hook-types.ts`, plus ~150 lines of tests and this design doc.
- One protocol version bump.
- No migrations: the endpoint file is reconstructed on every `start()`; its presence or absence on disk at startup is irrelevant.
- No IPC changes, no UI changes.

## Open Questions

1. **Should we delete the endpoint file on clean shutdown?** **Resolved: no.** `stop()` intentionally leaves the file on disk. A stale file points at a dead port, which matches the fail-open policy (hook POSTs silently fail, same as pre-endpoint-file behavior). An earlier iteration added a token-matched `unlinkEndpointFile()` on stop for "filesystem hygiene", but that has a residual TOCTOU: between the token read and the `unlinkSync`, a concurrent Orca instance sharing userData can `renameSync` a fresh file over our path, and our unlink then deletes the peer's live file despite the token check passing moments before. The original hygiene argument is also weak: the endpoint file is written with mode `0o600`, so it is not world-readable in the first place. The next successful `start()` overwrites the file atomically; orphan `.tmp` files from crashed writers are swept inside `writeEndpointFile()`. TOCTOU-free by construction.
2. **Hook-script auto-upgrade on version mismatch.** Deferred — see "Migration gap" under Goals for the resolution. In short: users with a pre-fix script either reinstall from Settings (prompted by the existing throttled server-log warning) or simply spawn a new PTY. Auto-reinstall would silently overwrite user-customized `settings.json` hook blocks and needs its own design before shipping.
