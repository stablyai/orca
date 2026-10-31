# Orca Relay

The relay that connects the Orca mobile app to a desktop host. Phones and
desktops never talk to each other directly: each opens an outbound WebSocket
to a relay cell, the relay pairs the two sessions, and it splices frames
between them. A director assigns hosts to cells and coordinates migrations;
cells carry the user connections.

This directory is an independent pnpm workspace inside the Orca monorepo. Run
its commands from `cloud/`, not the repository root. The source is covered by
the repository's root [MIT license](../LICENSE).

The [2026-10-21 security review](docs/relay-security-2026-10-21.md) records
dependency/container scans, remaining upstream advisories, CI coverage, and
the validation required before rolling out the updated images and host pins.

## Packages

- `packages/relay-contract`: the wire contract shared by the relay, the
  desktop app, and the mobile app (frame shapes, close codes, admission budgets,
  splice state machine).
- `apps/relay`: the relay server. The same image runs as a director or a cell
  depending on `ORCA_RELAY_ROLE`.
- `apps/relay-fence-broker`: a private, IAM-only service that owns the durable
  mutation lease, the Terraform checkout, and the narrow Compute mutation used
  when a registered target is superseded. The workflow that calls it holds read
  and invoke rights only, never those mutation permissions.
- `apps/push` and `packages/push-contract`: the mobile push gateway that holds
  the APNs key and sends to phones through APNs and FCM, and its wire contract.
  Deployment and operations are owned by the private `stablyai/orca-cloud` repository.
- `apps/connector` and `packages/connector-contract`: the Slack connector service
  (experimental). A signed-in Orca calls it with short-lived connector tokens
  from the auth service, checked the way the relay checks relay tokens.
  Deployed like push from the private repository.

## Mobile push gateway

`apps/push` is a separate Cloud Run service from the relay. Phones never hold an
Orca credential for it: the desktop host authenticates with the same X25519
key it uses for the relay, answering an encrypted challenge to mint a 24 hour
session, then registers each paired phone's native push token and asks the
gateway to push. The gateway queues each event as its own notification,
enforces per-host quotas and request limits, and retires a
registration as soon as Apple or Google reports the token unregistered.
Provider push is the only ordinary mobile OS-banner path. The notification
socket is retained only for live dismissal and reconnect tray reconciliation;
it never creates or recovers banners. Desktop notification categories remain
authoritative.
Each delivery is persisted as one notification event. Before deploying an
incompatible queue format, stop all older push gateway revisions and clear only
unpublished push delivery fixtures; no queue preservation or migration is required.
FCM notification messages are inherently collapsible while offline and have a
small concurrent collapse-key budget, so every pending alert is not guaranteed.

Storage follows the relay pattern: PostgreSQL in production, SQLite for tests
and local development. Configure it with `ORCA_PUSH_PUBLIC_URL`, `ORCA_PUSH_FCM_PROJECT_ID`,
`ORCA_PUSH_DATABASE_URL`, the three APNs variables (`ORCA_PUSH_APNS_KEY`,
`ORCA_PUSH_APNS_KEY_ID`, `ORCA_PUSH_APPLE_TEAM_ID`, all three or none), and
optionally `ORCA_PUSH_APNS_TOPIC`. The FCM credential comes from
the runtime service account, so no key material is configured for Android. See
[push gateway operations](https://github.com/stablyai/orca-cloud/blob/main/cloud/docs/push-gateway.md) for deployment and recovery.

Logging is aggregate counters only. Tokens, notification titles, notification
bodies, and full host fingerprints never reach a log line.

## Deployment configuration

The relay runtime and wire contracts are public. Production and staging Terraform,
backend configuration, operator tools, runbooks, broker image assembly, and deployment
workflows live in the private `stablyai/orca-cloud` repository. That repository pins
an immutable public source revision and combines it with its deployment configuration.

`Cloud Verify` here builds and tests public runtime code, audits dependencies, scans
relay and push images, and checks for secrets without cloud credentials. Private CI
also validates Terraform, scans the SQL proxy and broker, and runs deployment contracts.

## Local development

```sh
cd cloud
pnpm install
pnpm build
pnpm test
```

`pnpm test` runs the SQLite-backed suites. Tests that need PostgreSQL run only
when `ORCA_RELAY_TEST_POSTGRES_URL` points at a disposable PostgreSQL 16 or 17
database, for example:

```sh
docker run --rm -d --name orca-relay-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=orca_relay_test -p 55440:5432 postgres:16-alpine
ORCA_RELAY_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55440/orca_relay_test \
  pnpm --filter @orca-cloud/relay test
docker rm -f orca-relay-pg
```

Configuration is read from environment variables validated in
`apps/relay/src/config.ts`. `ORCA_RELAY_ASSIGNMENT_SIGNING_KEY` (at least 32
bytes) is the only required value; everything else has a local default.
