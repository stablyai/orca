# Egress release probe

`egress-probe.ts` checks sandbox egress against **dev** before a release. It goes through Orca's own
paths: real dev workspaces created with a dev-JWK user token, with commands run in a workspace
terminal over the shipped `orca` CLI's pairing code (the desktop's E2EE path to orcad). Every
credential is bogus, and postman-echo.com plays the model provider.

Setup for a throwaway identity, all of it removed afterwards:

- the dev GitHub App's installation, bound for the test repo (operator route);
- a stored GitHub identity, so member placeholders exist (the dev `member-github` route);
- bogus personal secrets:
  - `ANTHROPIC_API_KEY`, with `ANTHROPIC_BASE_URL` set to the echo host;
  - `OPENAI_API_KEY`, with `OPENAI_BASE_URL` set to `chatgpt.com/backend-api/codex`, so its egress
    takes the ChatGPT relay.

The probe creates two workspaces through the desktop's create path (clone after ready):

- **public**: a public repo the App isn't installed on. Member placeholder, no App token (#758).
- **app**: the App-installed test repo. App token, github.com fail-closed.

| Host | What must happen |
|---|---|
| echo host (custom base URL) | The provider sees the bogus key where the VM sent the placeholder. The other `authorization` header is unchanged, and no `vercel-forwarded-*` header or OIDC token arrives. A foreign key gets the firewall 403 `orca-egress-denied`. |
| chatgpt.com | The placeholder reaches ChatGPT: any provider answer counts, but not the firewall 403 and not Cloudflare's edge page. A foreign bearer gets the firewall 403. |
| api.github.com | No credential gets the firewall 403. With the workspace placeholder, GitHub answers 200. |
| github.com | Anonymous `git ls-remote` works on **public** (#758) and is refused on **app**. The app repo clones, and the workspace's own git works. |
| VM env | `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` hold placeholders. This is checked by sha256, so the bogus values never cross the terminal. |

The probe takes about 1–3 minutes, deletes what it created (`--keep` leaves it), prints one JSON
report and exits 1 on any failed expectation. It refuses any control plane other than dev.

## Run it locally

You need the Orca app installed (for its `orca` CLI) and `gcloud` access to the dev secrets.

```sh
cd cloud
pnpm install --filter @orca-cloud/sandbox-control...
K=$(mktemp -d)   # 0700; delete it afterwards
gcloud --account <you> secrets versions access latest --project onorca-cloud-staging \
  --secret orca-sandbox-control-dev-test-jwk > "$K/jwk.json"
gcloud --account <you> secrets versions access latest --project onorca-cloud-staging \
  --secret orca-sandbox-control-dev-operator-token > "$K/operator"
ORCA_PROBE_DEV_JWK_FILE="$K/jwk.json" ORCA_PROBE_OPERATOR_TOKEN_FILE="$K/operator" \
  pnpm --filter @orca-cloud/sandbox-control exec tsx scripts/egress-probe.ts
rm -rf "$K"
```

`ORCA_PROBE_CLI` points the probe at another `orca` CLI. The default is the installed app's.

## CI

`.github/workflows/cloud-egress-probe.yml` runs on manual dispatch. It installs the CLI from the
latest release's Linux package. It needs the `ORCA_DEV_TEST_JWK` and `ORCA_DEV_OPERATOR_TOKEN`
repository secrets, and warns and skips when they are missing. None are configured today.
