# Explicit Codex launch accounts

A coordinator can launch a new Codex worker on an existing managed account without changing the global account selection or restarting other sessions:

```sh
orca orchestration worker-start --task task_id --agent codex --account account_id --worktree current
orca worktree create --repo id:repo_id --name worker-b --agent codex --account account_id
```

Selectors accept an exact managed account id, a case-insensitive email that is unique among native host accounts, or `system` / `"System default"`. Exact ids take precedence. Unknown, ambiguous, untrusted, and unsupported account homes are refused. WSL accounts do not participate in native email matching.

Both commands require `codex.launch-account.v1` in the connected runtime's advertised capabilities. Missing or older capabilities fail before a launch mutation is sent. Connect directly to the execution runtime to use its accounts; `worker-start --on` federation, SSH-forwarded workspaces, paired-runtime repository forwarding, and WSL execution are refused. Native git worktrees and folder workspaces are supported on Windows, macOS, and Linux. Other providers, terminal reuse, session restoration, renderer-driven PTY creation, and custom Codex launch commands cannot guarantee this pin and are refused.

An explicit account uses a native terminal. If the user's default was a structured chat session, the mode receipt records `pinned_codex_account` as the downgrade reason. Omitting `--account` retains the existing launch mode, active-account routing, and account-home callback signature.

The account service resolves selectors and verifies home ownership. It prepares the requested managed home using the existing resource, config, hook, and session-history infrastructure, without invoking account switching or shared-auth transition bookkeeping. Explicit system selection uses the canonical system Codex home even when Orca inherited another pane's `CODEX_HOME`. The PTY receives that home only in its new launch environment. Existing credential readiness checks must succeed for that same home; they cannot fall back to another account. The returned home is checked against the existing account attribution resolver before spawning.

Pinned panes retain their effective account in the durable pane registry and are excluded from global-selection stale-account notices. Existing unpinned panes retain their normal account-switch behavior. No new credential store is introduced, and launch receipts contain no credentials or home paths.

`worktree.create` and `agent.launch` return an optional `account` receipt. Worker receipts contain the same value at `launch.account`, persisted in the Dispatch start options:

```json
{
  "provider": "codex",
  "requested": "b@example.com",
  "effective": { "id": "account-b", "email": "b@example.com" }
}
```

System receipts use `requested: "system"` and null effective id/email. Email requests are normalized; id requests retain the exact id. `agent.launch` accepts `account` only at the launch level and refuses a nested `target.create.startupAccount`. It includes the selector in its operation fingerprint and validates the account receipt during authoritative replay. Retrying the same operation returns its recorded effective account without resolving or launching again; changing its account conflicts. Explicit pins refuse `worktree.create`'s legacy `clientMutationId` cache, which does not compare account intent; use `agent.launch` with `operationId` for replay.

The capability is additive and has no new stream opcode. Hosts and clients update independently, so callers must not forward the selector to an unadvertised host. This implementation refuses forwarding entirely. Automatic quota failover is separate work tracked in [#20512](https://github.com/stablyai/orca/issues/20512); the concurrency use case is described in [#9496](https://github.com/stablyai/orca/issues/9496).
