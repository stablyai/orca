# Analytics session identity

The local Claude, Codex, and OpenCode usage stores expose
`getAnalyticsSessionId(providerSessionId): Promise<AnalyticsSessionId>` through
`UsageProviderStoreLifecycle`. The result is a random UUID v4, independent of the
provider's session ID. Repeated lookups and session resumes return the same ID,
including after an application restart.

Mappings are created on demand and saved before the accessor resolves. They live
beside the provider cache in `<cache-name>-analytics-session-ids.json`, separately
from disposable usage projections. Rebuilding or invalidating a usage cache does
not reset session identities. Deleting the identity file or the profile does.
A corrupt or unsupported identity file fails closed rather than silently replacing
previously issued identities. The existing durable usage-cache writer handles
atomic replacement, and the store's shutdown flush also waits for identity writes.

Each identity store has one owner, matching the provider usage store lifecycle.
Lookups and writes are serialized within that owner. Different providers and
execution-host profiles use separate files, so matching provider session IDs do
not join unrelated sessions. Future SSH reporting must request identities from
the execution host's usage store, not mint replacements on each viewing client.
The mapping has no repository or git-worktree dependency; folder workspaces use
the same accessor.

The provider-ID-to-analytics-ID mapping stays local. It is not added to usage
snapshots, renderer APIs, RPC payloads, or PostHog events. This change adds only the
identity primitive; a future exporter must apply consent before using it and send
only the analytics ID. A stable analytics ID links observations of one session and
is pseudonymous, not a guarantee of anonymity.

Snapshot revisions are separate from identity. A future exporter can persist a
counter that increases when a snapshot changes, preserving the same revision when
retrying that snapshot. An online query can then select the highest revision for
a session/day/model even when uploads arrive out of order. This PR does not add
that counter or any session-usage transmission.
