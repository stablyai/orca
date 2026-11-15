# Egress release probe

`egress-probe.ts` checks sandbox egress against **dev** before a release. It uses bogus tokens,
and an echo server running in a throwaway sandbox of our own stands in for the egress proxy and
for a model provider. No real credential is sent anywhere.

It tests two layers.

**1. Firewall (Vercel only).** A throwaway VM gets the exact policy that `egressPolicy()` compiles
for a workspace with a Codex account, an Anthropic key and a member's GitHub identity. The forward
rules point at the echo sandbox. The policy is applied twice: once with the repo's App token and
once without (the GH-ANON-403 shape, #758). From the VM:

| Host | Placeholder | Foreign or no credential |
|---|---|---|
| chatgpt.com | forwarded for chatgpt.com; `chatgpt-account-id` and `x-api-key` unchanged | firewall 403 `orca-egress-denied` |
| api.anthropic.com | forwarded; the other `authorization` header unchanged | firewall 403 |
| api.github.com | forwarded | firewall 403 |
| github.com, App token | forwarded | anonymous: firewall 403; `git ls-remote` refused |
| github.com, member only (#758) | member placeholder forwarded | anonymous `git ls-remote` of a public repo works |

**2. Swap (the dev control plane).** This layer creates a real dev workspace for a throwaway
identity, with a bogus `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` set to the echo sandbox. The VM
must hold only the placeholder. The echo (as the provider) must see the bogus key where the
placeholder was, with the other `authorization` header unchanged and no Vercel forwarding headers
or OIDC token. A foreign key sent to that host must get the firewall 403.

The probe takes about 1–2 minutes. It deletes everything it created (`--keep` leaves it in place),
prints one JSON report, and exits 1 on any failed expectation.

## Run it locally

```sh
cd cloud
pnpm install --filter @orca-cloud/sandbox-control...
# The dev team's Vercel token, from a file (never pasted on the command line):
export ORCA_PROBE_VERCEL_TOKEN_FILE=/path/to/dev-vercel-token
# For the swap layer: the dev test signing key, escrowed in Secret Manager.
gcloud --account <you> secrets versions access latest --project onorca-cloud-staging \
  --secret orca-sandbox-control-dev-test-jwk > "$TMPDIR/dev-jwk.json"
export ORCA_PROBE_DEV_JWK_FILE="$TMPDIR/dev-jwk.json"
pnpm --filter @orca-cloud/sandbox-control exec tsx scripts/egress-probe.ts   # --firewall-only skips layer 2
```

The script refuses any control plane other than dev.

## CI

`.github/workflows/cloud-egress-probe.yml` runs on manual dispatch and nightly. It needs the
`ORCA_DEV_VERCEL_TOKEN` and `ORCA_DEV_TEST_JWK` repository secrets, and skips with a notice when
they are missing.
