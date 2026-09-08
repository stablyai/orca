# BACKLOG-001: Ephemeral VM `ssh`-connection-type lifecycle

**Origin:** `specs/backend-go/bugs/missing-v3/tasks/TASK-006-ephemeral-vm-ssh-lifecycle-blocked-on-agent.md` (SOL-004 Group 2b)
**Priority:** Low — the other connection type (`orca-server`) already ships in full; this is the narrower, secondary path
**Blocked on:** A new `agent/` capability that does not exist today

---

## What this is

`ephemeralVm.*` (per-workspace ephemeral VM/container management) supports
two connection types for a provisioned VM: `orca-server` (fully implemented,
`backend-go`'s `EphemeralVmRelay` usecase) and `ssh` (a recipe that hands
back raw SSH connection details — host/port/username/identityFile instead of
pairing as a normal Orca-managed dev server).

For an `ssh`-type ephemeral VM, `attachWorkspace`/`suspendWorkspace`/
`resumeWorkspace`/`cleanup` currently return a permanent, typed error
(`INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED`) rather than doing anything, by
design — this is the correct, honest behavior until the real capability
below exists.

## Why it's blocked

Supporting this means the Dev Server Agent must become an **outbound SSH
client to a fourth, unrelated host** (the recipe's `ssh` target) — a
capability distinct from either of the agent's two existing WebSocket modes
to Orca itself (`agent/src/relay/agent-connection-relay.ts` — Orca dials
into the agent; `agent/src/relay/agent-connection-direct.ts` — the agent
dials out to Orca). Neither of those is an SSH client to a third-party host.

Confirmed absent: `agent/package.json` lists `ssh2`/`@types/ssh2` as
dependencies, but nothing in `agent/src` imports `ssh2` for outbound use —
the existing `ssh-*.ts` modules there all implement the *inbound* direction
(the agent being reached *through* an SSH exec channel Orca already opened).
Re-verify before picking this up (`agent/` may have changed):

```bash
grep -rn "from 'ssh2'" agent/src --include=*.ts | grep -v test
```

## What it would take (sketch, not a committed design)

- A real SSH2 client integration in `agent/`, dialing the recipe's target
  (host/port/username/identityFile/identityAgent/proxyCommand/jumpHost/
  portForwards — see `frontend/src/shared/ephemeral-vm-recipes.ts`'s
  `EphemeralVmRecipeSshTargetSchema`).
- A hidden-target registry distinct from user-visible SSH targets
  (`infra.ssh_targets`) — this connection is recipe-provisioned, not
  user-registered.
- fs/git provider dispatch equivalents for this new hidden target, mirroring
  `agent/src/main/ssh/ssh-filesystem-stream-reader.ts`/
  `ssh-git-response-stream-reader.ts` but for an agent-initiated outbound
  hop instead of an inbound one.
- A decision on how this hidden target's fs/git surface is exposed back
  through `git-gateway-service`'s existing repo→host dispatch, since the
  repo now effectively lives on a *fifth* machine (recipe's VM's SSH target),
  not the Dev Server itself.

Comparable in size to `desktop/`'s `ipc/ssh.ts` + provider-dispatch files
combined — real, multi-day capability work, not a quick wiring task.

## Where the guard that makes this safe lives today

`backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go`
— the `connection_type == "ssh"` check landed alongside `EphemeralVmRelay`
itself (TASK-004/TASK-005), so `ssh`-type runtimes fail loudly and
permanently rather than silently misbehaving. No urgency to "unblock" this
from a correctness standpoint — it's a missing feature, not a bug.
