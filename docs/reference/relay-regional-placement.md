# Relay regional placement

Orca selects a Relay region in the Electron main process before requesting a new assignment. The
director publishes an allowlisted region catalog containing only HTTPS cell subdomains of that
director. Orca discards one warm-up `/health` request per probe origin — a cold request pays TCP and
TLS setup that can exceed the round trip it measures — then takes three bounded samples and compares
regions by their minimum. A wide spread still rejects a region, but only a genuinely flapping one.
The stable choice is cached for 24 hours, and a cached region changes only when the alternative is
materially faster.

A region wins only against a measured competitor. If any region in the catalog is rejected or cannot
be measured, Orca sends no hint rather than selecting the sole survivor. Sending no hint is not
neutral placement: the director assigns `preferredRegion ?? RELAY_DEFAULT_REGION`, and the default
is `us-central1`. So an `asia-east2` user whose `us-central1` probe fails or flaps once is placed in
`us-central1` for that refresh. That trade is accepted because the relay database is
`us-central1`-only, and it is bounded: the withheld hint is cached for one hour, not the 24 hours a
chosen region gets, so the next hour re-measures. An origin that fails its warm-up probe is dropped
before the sampling rounds, so an unreachable region costs one probe timeout rather than four.

After a control socket registers, Orca probes the cell it actually landed on, once per cell URL per
process. The cache is deleted only when it names a region other than the best measured one and the
assigned cell is more than three times slower than that region — a far cell under a cache that still
names the best region means the director declined the hint, and re-measuring would return the same
answer. Self-heal skips an absent, expired, or no-hint cache, and never runs under
`ORCA_RELAY_REGION_OVERRIDE`.

The assignment request sends only `preferredRegion`. It does not send latency, IP address, country,
pairing data, or credentials. Catalog, probe, and cache failures fall back to an assignment without
a region preference. A rolled-back director that rejects the new field is retried once without
only that field while preserving reconnect behavior.

The selection measures the desktop network path. Folder workspaces and SSH workspaces share the
same local broker and do not run probes on remote hosts. The phone continues to connect to the
exact cell URL in the desktop pairing payload, so its location is not measured independently and
no mobile protocol update is required.

For deterministic local diagnostics, set `ORCA_RELAY_REGION_OVERRIDE` to `us-central1` or
`asia-east2` before launching Orca. The override is not an end-user setting and is not written to
the preference cache.
