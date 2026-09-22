# Orca Relay Operations

A private, aggregate dashboard for the Orca Relay control and data planes. It reads local `gcloud` and `gh` credentials on the server; credentials and per-user Relay state never enter the browser. One cached `gcloud auth print-access-token` refresh feeds concurrent read-only Google APIs so the collector does not stampede the local credential store.

## Run locally

Prerequisites:

- Node 24 and pnpm 10
- `gcloud` authenticated for `onorca-cloud` and `onorca-cloud-staging`
- `gh` authenticated with read access to `stablyai/orca-cloud`

From the repository root:

```sh
pnpm install
pnpm ops:relay
```

Open <http://127.0.0.1:2455>. The server binds only to loopback and refreshes aggregate data every minute. Production and staging are read-only by default.

The cost panel is a labeled planning estimate. There is currently no Cloud Billing export in either project, so the dashboard cannot claim exact billed spend. GCP Billing remains authoritative.

## Share through Tailscale

Keep the dashboard bound to loopback and let Tailscale provide identity, TLS, and tailnet ACL enforcement:

```sh
tailscale serve --bg http://127.0.0.1:2455
tailscale serve status
```

Share the HTTPS URL printed by `tailscale serve status` with the team. Limit access to the intended operator group in the tailnet ACL. Do not use a public funnel. Stop sharing with:

```sh
tailscale serve reset
```

For a persistent host, run `pnpm --filter @orca-cloud/relay-ops build` and supervise `pnpm --filter @orca-cloud/relay-ops start` with the host's normal process manager. The process needs the same non-interactive `gcloud` and `gh` identities.

## Optional staging controls

Controls are intentionally local-only and disabled unless explicitly enabled:

```sh
RELAY_OPS_ENABLE_STAGING_CONTROLS=1 pnpm ops:relay
```

Even in this mode the service never changes GCP directly. It dispatches `.github/workflows/power-relay-staging.yml`, preserves the workflow's typed `WAKE_STAGING` / `SLEEP_STAGING` confirmation, and always wakes only configured-admission cells. Requests require the loopback origin and a per-process CSRF token, so controls stay unavailable through the Tailscale view.

## Data and security boundaries

- Browser payloads contain aggregate Monitoring points, resource health, immutable image digests, alert-policy metadata, and workflow metadata.
- Account IDs, host IDs, device IDs, pairing state, assignment rows, bearer tokens, service-account tokens, startup scripts, secret values, and individual Relay-admin state are excluded.
- Sleeping staging is inventory-only. Viewing it does not probe or cold-start Cloud Run services and cannot resize empty MIGs.
- Partial GCP or GitHub failures degrade the affected panel and produce a sanitized warning.
- Missing cell inventory renders as `Unknown`, never `Sleeping`. After one successful read, transient credential or collector failures retain the last good snapshot and mark it stale.
- Responses use `no-store`, a restrictive CSP, frame denial, and no-referrer headers.

## Verification

```sh
pnpm --filter @orca-cloud/relay-ops test
pnpm --filter @orca-cloud/relay-ops typecheck
pnpm --filter @orca-cloud/relay-ops build
```
