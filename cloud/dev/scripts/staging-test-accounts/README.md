# Staging test accounts

Test accounts for the accounts, team and billing flows against staging auth
(https://auth-staging.onorca.dev, PropelAuth test env) and the dev billing Worker
(https://orca-billing-dev.lovecast.workers.dev, Stripe test mode). Never use them against production.

| Label  | Email                          | Orca user id                                | Team role                         |
| ------ | ------------------------------ | ------------------------------------------- | --------------------------------- |
| OWNER  | neil+orca-stg-owner@stably.ai  | usr_37582864-feb3-43e7-8604-e93c22d11885    | Owner of both teams               |
| MEMBER | neil+orca-stg-member@stably.ai | usr_2711da3a-5af3-4023-a6be-a3b21d2e112d    | Member of Orca Staging Eval Team  |

Teams: Orca Staging Eval Team (`org_5cc9ceb6-3bc2-4259-8152-ea232e15ed16`) and Acme Eval 080424
(`org_fc3a415d-0a9d-47b2-a16f-af4e67947ecd`).

## Secrets

Passwords live only in `~/.orca-secrets/staging-test-accounts.env` (0600; override the path with
`ORCA_STAGING_ACCOUNTS_FILE`). The scripts read the PropelAuth (test env) API key from
`~/.orca-secrets/staging-propelauth-api-key` (0600; override with `ORCA_STAGING_PROPELAUTH_KEY_FILE`)
when it exists. Otherwise they read the staging secret `propelauth-api-key` (GCP project
`onorca-cloud-staging`) on each run, which needs a non-expired `gcloud auth login`. The key stays in
memory. The scripts refuse to talk to anything but the PropelAuth test env, and they never print
passwords, tokens or keys. Nothing secret is committed.

## Scripts

All scripts need `gcloud` access to `onorca-cloud-staging`; `signin.mjs` also needs the repo's
Playwright Chromium.

- `node provision.mjs [--reset-passwords]`: creates or repairs both users (email confirmed) and the
  Orca Staging Eval Team membership, then writes the accounts file. It's idempotent. Run it on a
  new machine, or with `--reset-passwords` when the file is lost.
- `node signin.mjs OWNER|MEMBER --print-ids`: real desktop PKCE sign-in, headless. Prints the Orca
  user id, the teams, and which capability flags are on. `billing` and `sandbox` should be listed.
- `node signin.mjs OWNER|MEMBER --session-out <file>`: same, and writes the session tokens (0600).
- `node signin.mjs OWNER|MEMBER --open-url-file <file>`: signs a dev desktop in. Launch the app
  with `ORCA_CLOUD_DEV_OPEN_URL_FILE=<file>` and click Sign in; the script completes the hosted
  login and the app receives the callback.
- `node cleanup-teams.mjs [--yes] [org_<id> ...] [--prefix <name prefix>]`: deletes the throwaway
  teams that checks leave behind. It's a dry run unless you pass `--yes`. It only touches teams that
  meet all three conditions:
  - one of the test accounts owns it;
  - the name starts with a throwaway prefix (`W9 Acceptance `, `Invite Paging Check `,
    `Orca Check `), or you named its Orca id;
  - it isn't one of the two kept eval teams.

  Run `node cleanup-teams.mjs --yes` after every check that creates teams.
- `node invite-paging-check.mjs [N=105]`: live check of more than 100 pending invites. It creates a
  throwaway team, seeds N example.com invites, checks that the roster lists all N, revokes one from
  page 2, checks for N-1, then deletes the team.

## Billing and sandbox allow-list

Staging gates the `billing` and `sandbox` capabilities per account. The list lives in
stablyai/orca-cloud in two places that must agree:

- `AUTH_BILLING_ACCOUNTS` and `AUTH_SANDBOX_ACCOUNTS` in `.github/workflows/deploy-auth-staging.yml`
- `auth_feature_accounts` in `infra/terraform-apps/environments/staging.tfvars`

A test enforces that the two match, so neither a release nor a Terraform apply drops it. To add an
account, edit both, merge, and run Deploy Auth Staging. Don't set the env vars by hand. The next
release removes anything the workflow doesn't stamp.

## Desktop env for staging

```
ORCA_CLOUD_API_URL=https://auth-staging.onorca.dev
ORCA_CLOUD_CLIENT_ID=orca-desktop
ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION=1
ORCA_BILLING_API_URL=https://orca-billing-dev.lovecast.workers.dev
```
