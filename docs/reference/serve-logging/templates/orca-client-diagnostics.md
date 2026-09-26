# Orca Client Diagnostics Runbook

Verify a **client** can reach and authenticate to a (presumed-healthy) `orca serve`.
This is Bucket 4 of the troubleshooting matrix: the serve is bound and LISTENing, so the
fault is on the client side of the connection — reachability, environment resolution, or
pairing state. Run top-to-bottom; stop at the first failing step and fix there.

> If the serve itself is down, this runbook will not help — resolve Buckets 1–3 first using
> `orca-serve-troubleshooting-matrix.md`.

---

## 0. What "works" means

A healthy client, in order, must:

1. **Reach** the transport endpoint (`ws://<pairing-address>:6768`).
2. **Resolve** the environment id to a live runtime (no "Unknown environment").
3. **Pair** — E2EE keypair + device token match between client and serve.
4. **Attach** to the *current* runtimeId (not a stale one left from a pre-restart pairing).

---

## 1. Check reachability

```bash
# TCP reachability to the advertised pairing address (WireGuard/overlay IP, not always localhost)
nc -zv <pairing-address> 6768

# From the serve host itself, confirm what's actually bound
ss -ltnp | grep -E ':(6768|6769|6770|6771)'
```

| Fails as | Meaning | Fix |
|----------|---------|-----|
| `Connection refused` | Nothing LISTENs on that address/port, or the address is wrong | Confirm serve is `active` on the *serve* host; confirm the client dials the correct `ORCA_PAIRING_ADDRESS` (not `localhost` when the serve advertises an overlay IP) |
| `No route to host` / timeout | Network/firewall drop | WireGuard/overlay down, firewall blocking 6768, or WSL2 `localhostForwarding` off for PC loopback dials |

**Windows (WSL2) loopback note:** when the client dials `ws://localhost:6768` against a
WSL-hosted serve, ensure `localhostForwarding=true` in `.wslconfig`, otherwise Windows does
not forward the loopback port into WSL.

---

## 2. Check environment resolution

The CLI dispatches to a **local unix socket** (`o-*.sock`, same host) or a **remote
WebSocket** based on `--environment` / `ORCA_ENVIRONMENT`. A selector that names no live
runtime is the "Unknown environment" failure.

```bash
# Does the client's environment id resolve to a live runtime?
orca --environment <id> status --json | jq '{runtimeId, pid, version, reachable}'

# On the serve host: is that runtime id actually LISTENing on the pinned port?
cat "$ORCA_CONFIG_DIR/orca-runtime.json" | jq '{runtimeId, pid}'
ss -ltnp | grep 6768
```

| Symptom | Meaning | Fix |
|---------|---------|-----|
| `Unknown environment: <id>` | The client's environment id has no matching live runtime (serve came up with a blank/unset env-id, or the selector was stripped/mismatched) | On the serve host, verify `ORCA_ENVIRONMENT` matches a registry `name`; use the registry id in the client's `--environment` flag |
| Runtime resolves but pid dead | `orca-runtime.json` points at a phantom/dead pid (identity churn) | Re-run serve bring-up so a clean runtime is captured; do not hand-edit the json |

---

## 3. Check pairing material (E2EE keypair + device token)

Pairing survives version swaps and restarts — a restart mints a **new runtimeId**, but the
keypair and token persist. A *re-pair from scratch* is only needed if the keypair itself
diverged (e.g. restored from a stale backup).

```bash
# Keypair present + fresh on the client?
ls -la ~/.config/orca/orca-e2ee-keypair.json          # Linux
ls -la "$HOME/Library/Application Support/orca/orca-e2ee-keypair.json"   # macOS
dir "%APPDATA%\orca\orca-e2ee-keypair.json"            # Windows

# Token/keypair mismatch signs: "device mismatch", "not paired", or repeated re-pair prompts
```

| Symptom | Meaning | Fix |
|---------|---------|-----|
| Repeated re-pair prompt after an otherwise-clean restart | Client keypair ≠ serve keypair (stale restore) | Reload the correct keypair backup on the client, or re-pair once and back up the fresh keypair |
| `deviceToken` reject | Token rotated / mismatched | Re-pair; capture the new token to the shared secret store |

---

## 4. Check runtimeId (stale pairing id / activeRuntimeEnvironmentId)

The "orphan-until-relaunch" class: the serve restarted and minted a **new runtimeId**; the
client stays pinned to the old id and silently retries reconnect with stale state.

```bash
# Client's pinned runtime vs the serve's current runtime — do they match?
orca --environment <id> status --json | jq -r .runtimeId     # client view
cat "$ORCA_CONFIG_DIR/orca-runtime.json" | jq -r .runtimeId   # serve truth
```

| Symptom | Meaning | Fix |
|---------|---------|-----|
| Client id ≠ serve id, and the client shows "disconnected, retrying" forever | Stale runtimeId pin | Relaunch the client (session rebuild, not a re-pair). A code fix addresses the stale-pin reconnect path |
| Ids match but still retrying | Different failure (reachability or auth) | Recheck steps 1–3 |

---

## 5. Check version skew

```bash
orca --version                 # client
orca-serve-version status      # serve (on the host)
```

Client and serve should be within a compatible protocol window. A hard skew (daemon-init
`killStaleDaemon` vs a newer runtime, or a changed transport contract) shows as a handshake
rejection in the serve journal rather than a clean error. Align versions or pin the slot with
`ORCA_VERSION` in its `<slot>.env`.

---

## One-shot verification (Linux client)

```bash
set -eux
nc -zv <pairing-address> 6768
orca --environment <id> status --json | jq -e '.reachable == true'
test "$(orca --environment <id> status --json | jq -r .runtimeId)" = \
     "$(cat "$ORCA_CONFIG_DIR/orca-runtime.json" | jq -r .runtimeId)"
cmp ~/.config/orca/orca-e2ee-keypair.json <kept-backup>/orca-e2ee-keypair.json
```