# SEC-3: moving the secrets-store KEK behind a KMS (design, not implemented)

Status: phase 1 Worker code is implemented behind `SECRETS_KEK_SOURCE=kms` (off by default; `src/secrets-kms.ts`, tested against a fake KMS only, never against Google). No KMS resources exist: provisioning and turn-on are in the launch runbook, for Neil. Phase 2 is design only.
Differences from the plan below: the wrapped KEK is bound to its KEK id with KMS additional authenticated data; there is no cache window or stale-on-error (keys stay in memory for the isolate's life, so revocation needs a redeploy); a failed unwrap is retried at most every 10 seconds; with the flag on, `SECRETS_KEK` is never read (no fallback), and create/wake answer 503 `secrets_unavailable`.
Prices, latencies and vendor feature claims are from memory of public docs and are **unmeasured**; check each before committing.

## Where we are after the SEC-3 PR

- Per-row data keys (DEK, AES-256-GCM) wrapped by one key-encryption key (KEK). The KEK is a Cloudflare Worker secret (`SECRETS_KEK`), with a copy in GCP Secret Manager (launch runbook 1.6a).
- Three tables hold wrapped DEKs: `secrets`, `agent_credentials`, `github_user_tokens`.
- Rotation now re-encrypts: `POST /v1/internal/secrets/rewrap` moves every row to the active KEK, and `GET /v1/internal/secrets/kek` says when a retired KEK is unreferenced.
- A v2 row format (off by default, `SECRETS_SEAL_FORMAT=v2`) lets rotation re-wrap the 32-byte DEK without decrypting the value.

What is still true: the KEK is a static, exportable 32-byte value. Anyone who can read the Worker secret and export D1 can decrypt every stored secret offline, with no log entry and no way to revoke after the fact.

## Threat model

| Threat | Today | KMS-wrapped KEK (phase 1) | Per-org keys under KMS (phase 2) |
|---|---|---|---|
| D1 export alone (backup leak, SQL access) | Safe: ciphertext only | Safe | Safe |
| Cloudflare account access: read Worker secrets + D1 | **Decrypts everything, offline, silently** | Attacker gets a wrapped KEK and a GCP credential. Must call KMS: every call is in Cloud Audit Logs, and disabling the service account or key version stops it. Data exfiltrated before revocation is still lost | Same, and each org's key is a separate logged unwrap, so the logs show which orgs were touched |
| Code execution in the Worker (malicious deploy, dependency) | Decrypts whatever it asks for | Same. A KMS does not help when the legitimate caller is compromised | Same, limited to the orgs it unwraps while it runs |
| Leaked KEK copy (laptop, transcript, password-manager export) | Decrypts everything until a rotation plus sweep completes | The KEK plaintext exists only in Worker memory and in the escrow copy, so there are fewer places to leak from | No long-lived exportable root key exists at all |
| KEK lost | Every secret unrecoverable; recovery depends on the Secret Manager copy | The KMS key is the durable copy (scheduled-destroy window before deletion); escrow copy still advised | Same |
| Insider at Orca with Cloudflare admin | Can decrypt | Can decrypt, but leaves an audit trail in a system they may not administer | Same |

So a KMS does **not** make the store zero-knowledge and the white paper must not say so. What it buys: an audit trail on key use, fast revocation, a non-exportable root, native rotation, and separation of duties between whoever runs Cloudflare and whoever runs GCP IAM.

## Options

### A. GCP Cloud KMS (recommended)

A symmetric `ENCRYPT_DECRYPT` key in the GCP project that already holds Secret Manager. The Worker calls `cryptoKeys.decrypt` over REST.

- Worker auth to GCP: a service-account key held as a Worker secret, used to sign a JWT with WebCrypto and exchange it for a one-hour access token (cached). The account gets `roles/cloudkms.cryptoKeyDecrypter` on that one key and nothing else. If Cloudflare offers workload identity (an OIDC token GCP can federate) by the time this is built, use that instead and hold no long-lived GCP credential. I have not confirmed that it exists.
- Turn on Data Access audit logs for Cloud KMS, or the decrypt calls are not logged. Alert on decrypt volume.
- Protection level: software is enough to start. HSM (FIPS 140-2 Level 3) is a per-key setting and a later switch if a customer asks.

### B. Cloudflare

- **Worker secrets** (today): encrypted at rest by Cloudflare, value delivered in plaintext to the Worker, usable by anyone who can deploy to the Worker.
- **Secrets Store**: account-level secrets with their own roles, bound into Workers. Better access control and one place to rotate, but the Worker still receives the raw key, there is no unwrap API and no per-use audit. It does not change the table above.
- I know of no Cloudflare product that offers a general encrypt/decrypt API with a non-exportable key. Keyless SSL and Geo Key Manager cover TLS keys only.

Cloudflare alone can tidy access control but cannot close the gap.

### C. AWS KMS

Same shape as A. Orca Cloud has no AWS footprint, so it adds a vendor for no gain.

### D. Fetch the KEK from GCP Secret Manager at cold start

Cheap, since the secret already exists. It gives an access log and revocation, but the KEK stays exportable to every principal with the accessor role, and it is a dead end for phase 2. Not recommended over A.

## Recommended design

### Phase 1: KMS-wrapped KEK, unwrapped once per isolate

- The KEK stays a 32-byte AES key and the row format does not change. Instead of `SECRETS_KEK` (plaintext), the Worker gets `SECRETS_KEK_WRAPPED` (the KEK encrypted by the KMS key).
- On first use in an isolate the Worker calls KMS decrypt once, imports the result as a non-extractable `CryptoKey`, zeroes the bytes and caches the keyring in memory. `keyringFor(env)` in `secrets.ts` already caches per isolate and already returns a promise, so the seam exists.
- Retired KEKs are wrapped the same way.
- Row DEKs are still unwrapped locally, so session start costs no extra KMS calls.

This is the smallest change that moves the long-lived plaintext key out of Cloudflare config. Its limit: one successful KMS call yields the KEK, which opens everything. The call is logged and revocable, but the blast radius of a single call is the whole store.

### Phase 2: per-org keys, KMS as the root

- Add a key per owner account (org or user), wrapped by KMS and stored in D1. Row DEKs are wrapped by their owner's key.
- The Worker unwraps an org key on demand and caches it: one KMS call per org per isolate per cache window.
- No exportable key covers the whole store. The audit log shows per-org access. It also opens the door to customer-managed keys (a customer supplies the KMS key for their org).
- With v2 rows this migration is a DEK re-wrap done by the existing sweep. No value is decrypted.

Do phase 2 only when an enterprise customer asks for per-tenant keys or customer-managed keys. Phase 1 addresses the gap in the white paper.

### Why not call KMS per row

A session start opens up to about 100 secrets per owner across three scopes. One KMS call each would add seconds to start and make every start depend on KMS. Per-row DEKs under a cached wrapping key keep KMS off the hot path.

## Latency (expected, unmeasured)

- Cloud KMS decrypt is typically tens of milliseconds from a nearby region. Workers run at the user's edge, so a distant PoP could see 100 to 300 ms. Use a multi-region key location (`us` or `global`).
- The first call in an isolate also pays the token exchange, roughly another 100 ms.
- The cost is paid once per isolate per cache window, on the first secrets read or write. Session start already takes seconds, so this is not visible there. The secrets settings page would see it on a cold isolate only.
- Measure in dev before deciding the cache window.

## Cost (list prices from memory)

- Software key version: about $0.06 per month. HSM: about $1 to $2.50 per month.
- Operations: about $0.03 per 10,000.
- With per-isolate caching this is a few dollars per month at most. Audit log storage is the larger line and is still small.

## Failure modes

| Failure | Behaviour to build |
|---|---|
| KMS unreachable, isolate already has the keyring | Keep serving from cache. Extend the cache past its window while KMS is down (stale-on-error), with a ceiling of a few hours |
| KMS unreachable, cold isolate | Secrets routes answer 503. Session start must **not** proceed silently without secrets, which is what a missing `SECRETS_KEK` does today: retry with backoff, then fail the start with a clear error |
| Service-account key revoked or expired | Same as unreachable. Alert on the first failed unwrap |
| KMS key version disabled (deliberate revocation) | Cached isolates keep working until the cache window ends. For an emergency, also redeploy the Worker, which drops every isolate |
| KMS key destroyed | Scheduled destruction has a waiting period (30 days by default) in which it can be restored. Keep the escrow copy below as a second line |
| Wrong wrapped blob deployed | `GET /v1/internal/secrets/kek` shows rows under an unknown KEK, and a dry-run rewrap reports rows that will not open. Run both after every key change |

Cache window: the trade is revocation speed against KMS dependence. Start at 15 minutes with stale-on-error.

## Backup and escrow

- Phase 1: the KEK still exists as bytes. Keep the Secret Manager copy from runbook 1.6a as escrow, with read access cut down to the break-glass group. The wrapped blob is not sensitive without KMS access.
- Phase 2: org keys live in D1 wrapped by KMS. The KMS key is the root and cannot be exported, so backup means protecting the key from deletion (IAM deny on destroy, the scheduled-destroy window, an org policy) and covering D1 with its normal backups.

## Migration plan (phase 1)

No step below has been run. Steps 1 and 2 are infra changes for a human to approve.

1. Terraform, dev project first: key ring and key, service account with decrypt on that key only, Data Access audit logs for KMS, an alert on decrypt count.
2. Wrap the existing KEK: read it from Secret Manager and call KMS encrypt in one pipeline so it is never printed. Store the result as `SECRETS_KEK_WRAPPED`. Store the service-account credential as a Worker secret.
3. Ship the Worker change: prefer `SECRETS_KEK_WRAPPED` plus KMS, fall back to `SECRETS_KEK`. The KEK id stays the same, so no row changes.
4. Verify in dev: `GET /v1/internal/secrets/kek` shows no unknown ids, and `POST /v1/internal/secrets/rewrap {"dryRun":true}` run to completion reports `failed: 0`.
5. Delete the `SECRETS_KEK` Worker secret. The plaintext KEK is now only in Worker memory and in escrow.
6. Rotate once: generate a new KEK, wrap it, make it active, list the old one as retired, run the sweep, drop the retired entry. This retires the key that once sat in Cloudflare config as plaintext. The SEC-3 sweep is what makes this step cheap.
7. Repeat 1 to 6 for prod, when launch gating allows it.

Rollback at any step before 5: remove `SECRETS_KEK_WRAPPED`; the Worker falls back to `SECRETS_KEK`.

Estimated work: about 2 days of Worker code and tests (GCP token exchange, KMS client, cache with stale-on-error, fail-closed session start), plus the Terraform.

## Why this was not implemented now

It needs a KMS key, a service account and IAM bindings. Those are infra changes, which the brief ruled out. A prototype against a fake KMS would only test our own mock. The code seam is small and already in place (`keyringFor` is async and cached), so nothing in the SEC-3 PR has to be redone.

## Before phase 1

- Turn `SECRETS_SEAL_FORMAT=v2` on (dev once every preview branch contains the SEC-3 PR; prod from day one) and run the sweep once so every row is v2.
- Confirm who can read the Secret Manager copy of the KEK and record it in the runbook.
