# Relay regional placement

Orca selects a Relay region in the Electron main process before requesting a new assignment. The
director publishes an allowlisted region catalog containing only HTTPS cell subdomains of that
director; Orca takes three bounded `/health` latency samples per region and caches the stable choice
for 24 hours. A cached region changes only when the alternative is materially faster.

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
