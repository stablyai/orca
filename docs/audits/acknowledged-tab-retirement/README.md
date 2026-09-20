# Acknowledged terminal-tab retirement

A host-requested whole-tab close can return `closed: true` while its row remains in `orca-data.json`. Once a repository's host topology revision is positive, the Store preserves host membership against a renderer save that merely omits a tab. The renderer acknowledges after its session flush; its graph removal can arrive later. The existing runtime fallback committed retirement only after that graph stopped owning the parent.

This fixes that acknowledgement ordering path relevant to [#17344](https://github.com/stablyai/orca/issues/17344). It does not establish that every tab in that report followed this path or explain large RSS from the small persisted row alone.

## Run

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/acknowledged-tab-retirement/reproduce.mjs
```

The runner uses temporary Vite configurations and the repository's cross-platform process runner. It reverses only `fix.patch` in memory for the baseline; the checkout remains unchanged. Tests use temporary Store files and inert desktop/provider ports. No application window, shell, SSH connection, or external host is started.

The 20-case artifact fixture drives the actual renderer close and session builders, Store persistence/reload, and runtime close/graph methods. Eleven source regressions exercise actual Store/runtime boundaries, including provider exit and spawn. The baseline has **28 failing fixed-behavior assertions and 3 passing controls**; the fix passes **31 cases**. Results include source hashes, exact failed cases, process exit codes, and timeout status.

## Ownership checks

The acknowledged-close path captures the original execution-host partition, persisted tab creation/generation, leaf/PTY bindings, and current process incarnations. It rechecks these after the renderer acknowledgement before committing the existing host retirement transaction. Original leaves may disappear during physical exit, and the tab's aggregate PTY or remote-session ID may promote an original surviving sibling. A new leaf, binding, incarnation, tab generation, or host is refused. Current pins are checked by the existing commit primitive; explicit force retains its existing meaning.

The process guard covers original persisted row, remote-session and leaf IDs, plus snapshot leaf/layout IDs. Thus a partial mobile snapshot cannot hide an original sibling's replacement. Missing runtime records alone are not treated as evidence of process death. The existing headless fallback still collects persisted SSH kill IDs before it commits; the added renderer-owned path issues no provider kill.

Controls include local and SSH-backed repositories and folder workspaces, unrelated host partitions, same-ID replacements, physical split exits, stale renderer saves/graphs, current pins, force, renderer refusal, and disk failure. The renderer-owned live snapshot can remain until its ordinary graph removal arrives; an older queued graph cannot restore it afterward.

## Scope limits

- A direct renderer-only close of a never-bound local tab still sends no explicit host retirement request. That separate gap remains reproduced by a negative control.
- The new durable identity capture requires the legacy terminal row in `tabsByWorktree`. Unified-only terminal metadata is outside this fix.
- The existing retirement primitive propagates a failed disk flush, but its attempted rollback can be rebased against the staged newer topology revision. The failure control verifies rejection and the original disk row; it does not claim successful in-memory rollback.
- No wire fields, process-liveness verdicts, or membership-fence rules change. SSH persistence stays in its existing host partition; this does not reconcile the separate historical renderer/host partition divergence.
- The related [original audit](../local-tab-close-rebase/README.md) traced the branch in reported **v1.4.192**. Executable comparisons use current source with this patch reversed, not the historical packaged application.
