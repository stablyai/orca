# Server-owned workspace recipes

A recipe belongs to the host holding the project's primary checkout. For a
paired-server project, discovery and lifecycle commands run in that server's
process. The desktop supplies the explicit owner environment ID; the server
uses its own repository IDs, paths, SSH keys, and runtime store. A failed remote
call never runs the recipe on the desktop. Local projects retain their existing
path.

Desktop IPC and authenticated runtime RPC share the existing recipe engine.
The Electron-backed headless host registers recipe services before accepting
requests, after its existing SSH startup. For provisioned-root SSH recipes,
`ephemeralVm.provisionWorkspace` provisions, registers and adopts the checkout on
the server before replying. The desktop repeats registration/adoption
idempotently to populate its local view, retaining the nested SSH target ID.
Recipe-owner identity is separate from any guest Orca runtime identity.

## Disconnect, retry and cancellation

Provisioning requires a request ID. The owning profile durably records arguments
and results under `ephemeral-vm-provision-requests`; concurrent and completed
retries with identical arguments return the same result. Conflicting arguments
are refused. Client disconnection does not abort the host controller; cancellation
requires `ephemeralVm.cancelProvision`.

A pending request left by a host interruption is refused on retry. Inspect runtime
records and provider resources before creating a new request ID. The journal is
bounded at 4096 requests; archive settled records when needed. Removing a record
ends its retry protection, so retain it while clients may retry that ID.

The complete-workspace RPC currently requires a provisioned-root SSH recipe.
Raw recipe provision and lifecycle operations retain existing connection types.
A failed registration/adoption runs provider cleanup; if cleanup fails, recovery
metadata is retained. Replayed adoption tolerates agent commits after the original
checkout was adopted while still checking branch, path and SSH ownership.

## Permissions and compatibility

Recipe discovery, provisioning, progress and lifecycle RPCs require `host-admin`.
The owner and paired runtime clients retain their existing administration rights.
Mobile and guest SSH-bridge clients cannot invoke these methods, including bridges
with general workspace control enabled. Guest agents receive no provisioning
administration rights from this feature.

A server advertises `ephemeral-vm.host-lifecycle.v1` only after host registration.
Clients reject older servers explicitly. Owner fields are optional for existing
local recipe calls; existing clients and local recipes retain their paths.
Credentials remain in the owning host's existing protected storage. Project recipes
remain executable host-user code, governed by the existing recipe trust boundary.

This patch targets the published 1.4.227 SSH provider architecture on
`release/v1.4.227-from-224`. Development main's migration to managed SSH servers
is separate; this contribution does not restore removed providers on main or
change a worker's execution model. It addresses the recipe path related to #29593,
not manual SSH-host administration or CLI recipe selection from #26879.

## Host runtime selection

This release's supported host is Electron-backed headless serving. Select it
explicitly with `ORCA_SERVE_RUNTIME=electron orca serve` on Linux, where bare
`orca` must be replaced by the installed `orca-ide` launcher. Version 1.4.227 can
automatically select Node-only `orcad` for a new profile; this patch does not add
its missing SSH providers or recipe host. That runtime does not advertise the
recipe-host capability, so paired clients refuse this unsupported target.

## Validation and rollout

Run recipe, owner routing, request-journal, permissions, project-registration,
startup and adoption tests, all typecheck targets, the changed-code quality gate
and the runtime Electron import check. Build matched client and server artifacts
against this release, retaining each platform's original native modules. Test an
isolated profile and port before changing a persistent server.

Live acceptance: create a VM through Orca, adopt its pinned checkout, start a task,
close all UI/control connections, reconnect to the same terminal/task, and destroy
the VM and owned SSH target. Check retry identity, suspend/resume, cancellation
and failure cleanup. Unit tests or invoking a provisioner directly do not replace
that test. Agent authentication is separate and must not contaminate shared images.

The earlier 1.4.222 release patch passed Linux headless/SSH acceptance on a real
Incus VM, including fresh Nix tooling, a guest CLI call to the central runtime,
disconnected terminal progression, retry identity, suspend/resume and cleanup.
The 1.4.227 port requires its own checks; that earlier evidence is not a claim of
current desktop visual or cross-platform acceptance.

Rollback restores the previous binary and preserves the profile and worker disk
state. Loss of contact with a worker is not evidence that it exited or was cleaned.
