# Orca Relay

The relay that connects the Orca mobile app to a desktop host. Phones and
desktops never talk to each other directly: each opens an outbound WebSocket
to a relay cell, the relay pairs the two sessions, and it splices frames
between them. A director assigns hosts to cells and coordinates migrations;
cells carry the user connections.

This directory is an independent pnpm workspace inside the Orca monorepo. Run
its commands from `cloud/`, not the repository root. The source is covered by
the repository's root [MIT license](../LICENSE).

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
- `apps/relay-ops`: the relay operations console and the incident monitor
  behind `pnpm ops:relay`, `pnpm incident:relay`, and
  `pnpm incident:relay-preflight`.

## Infrastructure and operations

- `infra/terraform`: the relay Terraform root. It owns the cells, the director,
  the shared Cloud SQL instance, DNS, observability, and every GitHub Workload
  Identity provider the relay workflows authenticate through. `backend/` holds
  the per-environment backend configuration and `environments/` the tfvars.
  Drive it through `pnpm infra:init`, `pnpm infra:plan`, and `pnpm infra:apply`.
- `dev/scripts`: the deploy, capacity, admission, rehome, monitoring, and load
  scripts the workflows call, plus the contract tests that pin each workflow
  and Terraform surface. Run them with `pnpm test`.
- `dev/contracts` and `dev/fixtures`: the checked-in data those contract tests
  read, including the Terraform root partition.
- `docs/`: the relay runbooks, capacity-testing guide, incident-monitor
  reference, and the workflow variable reference in `docs/relay-workflows.md`.

## Workflows

The 24 `.github/workflows/cloud-*.yml` workflows are the relay's deploy and
operate surface: publish and deploy the director, roll GCE cell capacity,
operate Asia admission and regional rehoming, prove staging capacity, monitor
production, and power staging up and down. `.github/actions/cloud-sql-rollout-lease`
is the compare-and-swap lease that serializes every rollout against the shared
Cloud SQL instance.

Every one of them is inert. Each top-level job is gated on
`vars.ORCA_CLOUD_OPERATIONS_ENABLED == 'true'`, a repository variable that is
unset here, so the two scheduled triggers and every manual dispatch skip
without running a step. Only the repository owner, holding the GCP identities
these workflows authenticate as, can turn them on.

`Cloud Verify` is not gated. It builds, typechecks, lints, tests, secret-scans,
and validates the relay Terraform on every change under `cloud/`, and it runs
on fork pull requests, so it configures no backend and holds no credential.

## What is not here

The `terraform-foundation` and `terraform-apps` roots and the API and auth
services live in the private `stablyai/orca-cloud` repository. Scripts and
tests that spanned both trees were narrowed to the relay side rather than
carrying a dangling reference.

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
