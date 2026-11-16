# Relay security review — 2026-10-21

This review covers the checked-in Cloud workspace, its production and development
dependencies, relay/push/fence-broker container images, the Cloud SQL Auth Proxy,
Terraform provider binaries, and the configured COS host release. No deployment,
Terraform apply, or live resource mutation was performed.

The relay and push runtime images have zero reported vulnerabilities. The broker
has one advisory without an upstream fix. **The complete stack is not free of
known findings:** the latest official proxy and Terraform providers still embed
vulnerable dependencies. See the complete dated
[finding inventory](../security/findings-2026-10-21.json).

## Scan results

Counts are package/advisory instances, not unique CVEs or confirmed reachable
exploits. Container and provider scans target Linux amd64, matching the current
Cloud deployment. Trivy's advisory database was updated at
`2026-10-21T19:18:22Z`.

| Surface | Scanner | Before | After |
| --- | --- | --- | --- |
| Cloud production and development dependency graph | pnpm audit | 0 | 0 |
| Dependency graph, independent advisory source | OSV Scanner 2.7.0 | 0 | 0 (174 packages) |
| Relay runtime image | Trivy 0.76.1 | 12 | 0 |
| Push runtime image | Trivy 0.76.1 | Not captured | 0 |
| Fence broker runtime image | Trivy 0.76.1 | Vulnerable Debian, npm, Python and Terraform dependencies | 1 UNKNOWN, no fix |
| Cloud SQL Auth Proxy | Trivy 0.76.1 | 109 | 3: 1 HIGH, 2 UNKNOWN |
| Installed Terraform providers | Trivy 0.76.1 rootfs | 241 | 49: 12 HIGH, 32 MEDIUM, 3 LOW, 2 UNKNOWN |
| Cloud source snapshot secrets | Gitleaks 8.30.1 | 0 | 0 |
| Cloud source static security analysis | Semgrep 1.181.0 | 0 | 0 |

The final Semgrep scan ran `p/security-audit`, `p/javascript`, and
`p/typescript`: 101 applicable rules, 668 files, approximately 99.9% parsing.
A retry of 26 files resolved rule timeouts with a two-worker, 60-second
per-rule limit. Two partial-parser warnings affected tests (`apns-session-replacement.test.ts`
and `host-whereabouts-app.test.ts`). This is automated source analysis, not a
claim that every execution path was manually audited.

Trivy's source/configuration scan reported four LOW configuration findings:
three Dockerfiles without Docker HEALTHCHECK instructions, and a GCS bucket
without customer-managed encryption keys. GCP supplies the runtime health checks;
changing the bucket's encryption policy is an infrastructure policy decision.
Terraform scans with default inputs do not establish the live IAM/network policy.

## Updates

- Digest-pin Node 24.22.1 Alpine runtime/build images. Remove global npm,
  Corepack, Yarn and pnpm plus their caches after installing production modules.
  Exclude nested Terraform caches/state, node_modules, dist and environment files
  from Docker contexts so a local build cannot embed stale providers or secrets.
  Relay's twelve original image findings were entirely in the bundled npm tree.
- Upgrade Cloud workspace libraries and tooling to the current releases:
  Hono/node-server 2.1.5, Hono 4.13.13, pg 8.23.1,
  pg-connection-string 2.14.1, google-auth-library 11.3.1, Zod 4.6.7,
  TypeScript 7.0.2 and Vitest 5.0.5, with current compatible type packages.
  Keep Node typings on 24 and the compiler API test alias on TypeScript 6.0.3;
  TypeScript 7 no longer provides that API. Adapt Zod record/introspection calls
  and explicitly include Node types. Wire contract fields and versions stay the same.
- Pin the broker to Google Cloud CLI 590.0.0 Alpine and Terraform 1.17.0.
  Upgrade the SDK's actual vendored certifi/urllib3 using hash-locked requirements.
  Remove unused bq/gsutil, pip/wheel, and the vulnerable compiled CRC helper.
  Use gcloud's Python checksum implementation instead. Install libstdc++ for the
  Alpine Node runtime. The broker continues to run as uid 10001.
- Pin the official Cloud SQL Auth Proxy v2.26.2 by digest, replacing the old
  image. Its existing Unix socket, private IP and Cloud Run options are retained.
- Upgrade all Cloud workflow Terraform installations to 1.17.0. Lock Google
  provider 8.8.0, external 2.4.2 and random 3.9.1, including Linux/macOS/Windows
  checksums. Review the Google provider
  [v7](https://registry.terraform.io/providers/hashicorp/google/latest/docs/guides/version_7_upgrade)
  and [v8](https://registry.terraform.io/providers/hashicorp/google/latest/docs/guides/version_8_upgrade)
  migration notes before rollout. Preserve the prior instance-template disk
  defaults explicitly; load balancer schemes were already explicit.
- Update staging, production, and newly generated Asia cell inputs to
  `cos-121-18867-638-13`, the October 19 security release on the existing COS 121
  LTS milestone. Accept versioned LTS image names as well as legacy `cos-stable`
  names in validation. COS 121 remains supported through March 2027. This is
  release-note verification, not a scan of a running host or boot disk.

## Remaining upstream findings

- `GO-2026-5932`: the Go OpenPGP package is unmaintained and unsafe by design.
  Trivy reports the containing `golang.org/x/crypto` module in Terraform,
  the proxy, and two providers. No fixed module version is published; module
  presence alone does not establish that the affected OpenPGP functions execute.
- Proxy `CVE-2026-111943` (HIGH): official v2.26.2 embeds Go 1.27.2; the
  advisory requires Go 1.27.3 or 1.26.10. Proxy `DSA-6572-1` (UNKNOWN): the
  official distroless image predates the Debian ca-certificates rebuild.
  No newer official proxy release was available at review time.
- The latest external/random provider binaries embed Go 1.26.8; Google 8.8.0
  embeds Go 1.26.9. Additional findings affect their embedded x/net, x/crypto,
  and OpenTelemetry SDK versions. Updating a Terraform lockfile cannot patch
  dependencies inside signed upstream executables. External has 19 instances,
  Google 10, and random 20; all are itemized in the inventory.

Govulncheck 1.9.0 additionally analyzed the exact Linux amd64 Terraform, proxy,
and provider executables in binary symbol mode. The inventory records its
strongest evidence for each matching Go finding. OpenPGP is module-only in the
proxy, while its affected symbols are linked into Terraform, Google and random.
The proxy's affected `crypto/x509.Certificate.Verify` symbol is linked. These
checks establish linked code, not runtime exploitability or a production call
trace; the original Trivy findings remain visible.

| Binary | Unique Go advisories at module level | With affected linked symbols |
| --- | --- | --- |
| Terraform 1.17.0 | 1 | 1 |
| Cloud SQL Proxy 2.26.2 | 2 | 1 |
| Google provider 8.8.0 | 10 | 9 |
| External provider 2.4.2 | 13 | 13 |
| Random provider 3.9.1 | 14 | 14 |

CI retains unfiltered JSON and CycloneDX inventories for every runtime image and
installed Terraform providers, including these findings. Runtime image checks
reject advisories with available fixes at every severity. Only the two specific
proxy rebuild findings have a documented exception, expiring **2026-11-04** in
[the proxy exception file](../security/cloud-sql-proxy.trivyignore.yaml).
Unfixed runtime findings remain in the full reports. Provider scanning is
report-only while upstream binaries retain the findings above; it is not a
provider security approval gate. No global severity exclusions were added.

## Reproduce

Run from a fresh checkout; this is an independent pnpm workspace.

```sh
pnpm --dir cloud install --frozen-lockfile
pnpm --dir cloud audit
pnpm --dir cloud audit --prod
osv-scanner scan --lockfile cloud/pnpm-lock.yaml
gitleaks dir cloud --config cloud/.gitleaks.toml --redact
semgrep scan --config p/security-audit --config p/javascript --config p/typescript --metrics off --jobs 2 --timeout 60 --timeout-threshold 0 cloud
docker build --platform linux/amd64 -f cloud/apps/relay/Dockerfile -t orca-relay-security cloud
trivy image --scanners vuln --ignorefile '' orca-relay-security
```

Cloud Verify additionally builds push and broker (supplying the exact checkout
SHA as `ORCA_RELAY_FENCE_IMAGE_COMMIT`), resolves the proxy from Terraform, tests
nonroot runtime imports and broker tools, and scans installed provider binaries
after backend-free initialization. It needs no GCP credentials and publishes no
images. The existing full-history Gitleaks and snapshot TruffleHog checks remain.

## Validation and rollout

Cloud build and typecheck passed. Relay unit tests passed 1,249 tests with one
existing skip; all 217 PostgreSQL tests passed on a fresh, dedicated database
in an isolated run. Other Cloud packages passed 561 tests, Cloud pretests/runner
passed 233 tests, deployment scripts passed 889 tests, and the root secret-history
workflow tests passed 2 tests. Earlier concurrent runs encountered load-sensitive
contention assertions; reusing their database also exposed retained test fixtures.
No test assertions or timeouts were weakened. The isolated database suite passed
all 44 files. YAML/shell linting of the new workflow steps and the changed-code
quality check passed; Cloud source was additionally checked with Oxlint. The
installed actionlint predates the existing background/wait workflow syntax, so
that unchanged syntax was removed only from a temporary lint input.
Broker checks include Node module loading, gcloud startup, a known CRC32C value
through the Python fallback, Terraform version, backend-free initialization, and
configuration validation. Provider initialization validates signed checksums for
Linux amd64/arm64, macOS amd64/arm64, and Windows amd64; execution was tested on
Linux amd64. No native-focus or desktop UI testing is needed for these changes.

The local GCP session requires reauthentication. Live image inventory, live COS
versions, Cloud SQL maintenance state, deployed IAM/network configuration and
state-backed Terraform plans were therefore **not verified**. No assertion is
made that the deployed fleet already contains these updates.

Before deploying, recheck proxy/provider releases and the remaining advisories.
Build and publish the updated relay, push and broker images through the existing
release process and bind their immutable digests to the rollout inputs. Review
fresh staging and production Terraform plans with valid credentials, paying
particular attention to provider schema changes, the proxy digest, and expected
COS instance-template replacements. Canary staging before rolling production
cells through the existing drain/fencing flow. Preserve prior immutable images
and the versioned Terraform state for recovery; a provider downgrade after
state migration requires its own review. This PR does not perform those steps.

Sources: [Node releases](https://nodejs.org/dist/index.json),
[Cloud SQL Proxy releases](https://github.com/GoogleCloudPlatform/cloud-sql-proxy/releases),
[COS 121 release notes](https://docs.cloud.google.com/container-optimized-os/docs/release-notes/m121),
[COS support policy](https://docs.cloud.google.com/container-optimized-os/docs/concepts/versioning),
[OpenPGP advisory](https://vuln.go.dev/ID/GO-2026-5932.json).
