# Egress release probe

`egress-probe.ts` checks sandbox egress against **dev** before a release. It goes through Orca's own
paths: real dev workspaces created with a dev-JWK user token, with commands run in a workspace
terminal over the shipped `orca` CLI's pairing code (the desktop's E2EE path to orcad). Every
credential is bogus. httpbin.org plays the model provider, ws.postman-echo.com is the WebSocket
host, and postman-echo.com is an unrelated host.

Setup for a throwaway identity, all of it removed afterwards:

- the dev GitHub App's installation, bound for the test repo (operator route);
- a stored GitHub identity, so member placeholders exist (the dev `member-github` route);
- bogus personal secrets:
  - `ANTHROPIC_API_KEY`, with `ANTHROPIC_BASE_URL` set to the echo host;
  - `OPENAI_API_KEY`, with `OPENAI_BASE_URL` set to `chatgpt.com/backend-api/codex`;
  - `COPILOT_PROVIDER_API_KEY`, with `COPILOT_PROVIDER_BASE_URL` set to the WebSocket echo host.

The probe creates two workspaces through the desktop's create path (clone after ready):

- **public**: a public repo the App isn't installed on. Member placeholder, no App token (#758).
- **app**: the App-installed test repo. App token, github.com fail-closed.

Each mode is checked on the same two workspaces. `--mode proxy|firewall|both` flips them with the
operator route `POST /v1/internal/sandboxes/:id/egress-mode`; without `--mode`, the environment's
default applies. Every request is a Node `fetch` (undici, like the agents) with a 30 s limit, so the
undici body hang shows up as a named failure.

| Host or class | What must happen |
|---|---|
| echo host (custom base URL, a model key) | The provider sees the bogus key where the VM sent the placeholder. The other `authorization` header arrives exactly as sent, and no `vercel-forwarded-*` header or OIDC token arrives. A foreign key gets the firewall 403 `orca-egress-denied`. A chunked stream finishes. A 1 MB upload goes through: the public echo hosts refuse bigger bodies themselves. |
| chatgpt.com | The placeholder reaches ChatGPT: any provider answer counts, but not the firewall 403 and not Cloudflare's edge page. A foreign bearer gets the firewall 403. |
| WebSocket host | A WebSocket upgrade (101) through the swap. No credential gets the firewall 403. |
| an unrelated host | A placeholder sent there arrives unswapped: the real value never leaves for the wrong host. |
| api.github.com | No credential gets the firewall 403. With the workspace placeholder, GitHub answers. |
| github.com | Git smart-HTTP and the LFS batch API work with the workspace header, as do `git fetch`, a push of a probe branch and its delete. Anonymous `git ls-remote` works on **public** (#758) and is refused on **app**. Both repos clone through the desktop's create. |
| VM env | The keys hold placeholders. This is checked by sha256, so the bogus values never cross the terminal. |

The report includes latency per class (median and p90 over 5 keep-alive samples where set):
model_key, model_key_stream, upload_1mb, codex, websocket, github_api, git_http, git_lfs. It
reports these per mode and per workspace.

What it can't cover with bogus credentials: real provider SSE (Anthropic `/v1/messages`, Codex
`/responses` answer 401 before streaming). The chunked stream from the echo host exercises the same
transform path instead.

The probe takes about 3 minutes per mode, deletes what it created (`--keep` leaves it), prints one JSON
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
  pnpm --filter @orca-cloud/sandbox-control exec tsx scripts/egress-probe.ts --mode both
rm -rf "$K"
```

`ORCA_PROBE_CLI` points the probe at another `orca` CLI. The default is the installed app's.

## CI

`.github/workflows/cloud-egress-probe.yml` runs on manual dispatch. It installs the CLI from the
latest release's Linux package. It needs the `ORCA_DEV_TEST_JWK` and `ORCA_DEV_OPERATOR_TOKEN`
repository secrets, and warns and skips when they are missing. None are configured today.
