# ChatGPT relay (CODEX-RELAY)

chatgpt.com answers Cloudflare Workers' egress with a 403 "Unable to load site" page, so Codex via the
Orca account can't reach it through the sandbox-control egress proxy directly. The proxy sends its
chatgpt.com requests to this Cloud Run service instead (`cloud/apps/chatgpt-relay`), which:

- forwards to `https://chatgpt.com` only, on the Codex paths in `sandbox-control/src/codex-paths.ts`;
- streams responses as they arrive (SSE), refuses WebSocket upgrades (Codex is configured for HTTPS);
- logs method, a two-segment path, status and duration: never headers, bodies or queries;
- is callable only by `orca-chatgpt-relay-invoker` (Cloud Run IAM, ID token in `X-Serverless-Authorization`).

## Staging (serves orca-sandbox-control-dev)

```
terraform init -backend-config=backend/staging.hcl
terraform apply -var-file=environments/staging.tfvars                     # registry + accounts
IMG=$(CLOUDSDK_CORE_ACCOUNT=<you> ../../apps/chatgpt-relay/build-image.sh onorca-cloud-staging)
terraform apply -var-file=environments/staging.tfvars -var image=$IMG     # the service
```

Worker: `CHATGPT_RELAY_URL` (wrangler var) = the `relay_url` output; secret `CHATGPT_RELAY_SERVICE_ACCOUNT` =
a key of `invoker_service_account`, created with `gcloud iam service-accounts keys create` into a 0600 temp
file, piped into `wrangler secret put`, then deleted. Without both, chatgpt.com goes direct, as before.

## Production (runbook, at Neil's go)

1. Add `backend/production.hcl` (bucket `onorca-cloud-terraform-state`, prefix `terraform/chatgpt-relay`) and
   `environments/production.tfvars` (`project_id = "onorca-cloud"`, `environment = "production"`).
2. The same three steps against `onorca-cloud`.
3. Set `CHATGPT_RELAY_URL` in `wrangler.prod.jsonc` and the secret on `orca-sandbox-control-prod`; deploy.
4. Check: a Codex turn via the Orca account answers; the relay's logs show `relay ... status 200`.
