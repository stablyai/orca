# Independent release-tooling review

2026-09-10. **REVISE — one P2 finding.** No production operations. Read-only source review, plus local deployment mocks; only this report was written.

## P2 — Terraform can undo an audited nonzero cohort

`cloud/infra/terraform/relay.tf:173-174` manages `ORCA_RELAY_REGION_CORRECTION_COHORT_PERCENT` from `var.relay_region_correction_cohort_percent`, whose default is0 (`variables.tf:246-254`). The existing lifecycle ignores the container image but not this environment value (`relay.tf:379-382`). The deployment script instead inherits the serving revision value (`deploy-relay-blue-green.mjs:801-803`), and explicit workflow changes are protected by disabled-generation verification (`:804-807` and subsequent checks).

Concrete trigger: deploy an approved cohort1 through the documented workflow, then run an otherwise unrelated Terraform apply using checked-in defaults. Terraform desires0 and can publish a new director revision that disables correction, bypassing the workflow's audited value and disabled-control check. Conversely, stale nonzero tfvars after an emergency reset to0 could undo that reset if the global control is still enabled. No live Terraform plan was run; this follows directly from declared desired state and the lack of an environment ignore/read-preserve mechanism. The checked-in `.tfvars` files contain no cohort override.

The variable description says to keep it aligned, but rollout step6 (`RELAY-REGION-CORRECTION-ROLLOUT.md:24-26`) directs a workflow-only change. It does not close the competing ownership paths. Reuse the existing serving-setting preservation approach (the regional-placement secret version is already read from the serving revision), or establish one audited owner that prevents Terraform from silently replacing the runtime setting. Add a deterministic regression for a nonzero serving cohort and a later0 reset, not just deployment-script inheritance.

## P3 — rollback verification wording names a removed tag

Rollout step6 says to verify both tagged revisions. Successful `deployDirector` removes the promoted candidate tag and retains the rollback tag (`deploy-relay-blue-green.mjs:914-916`). Say to verify the serving revision and retained rollback revision/tag. Both receive the desired cohort and are checked before promotion; an operator should not expect two surviving tags.

## What passed review

- Cohort input accepts only integer strings0–100; missing/preserve is inherited and missing serving value bootstraps0.
- Explicit cohort changes cannot proceed without expected rehome generation. The actual verifier requires `enabled === false` and exact generation; normal workflow supplies all three inspection arguments and checks serving, rollback and candidate before promotion.
- Candidate and rollback environment checks include the resolved cohort via the shared expected-environment map. Both get the same cohort; this is configuration rollback under the new image, not permission to roll cleanup below its compatibility floor.
- Inputs are passed through workflow env and quoted shell arguments, not interpolated into shell code. Rehome and role argument validation is maintained.
- No new code was found that enables the durable rehome control automatically. Initial rollout remains cohort0/disabled, and minimum compatible worker revision is explicitly a future release gate.

## Executed evidence and limits

`ORCA_BACKGROUND_LAUNCH=1 node --test cloud/dev/scripts/deploy-relay-blue-green.test.mjs`: **33 passed,0 failed,0 skipped**. These are mocked operations, not a Cloud Run deployment or Terraform apply. No GCP calls, workflow dispatches or credentials were used. Review is limited to requested release tooling; it does not repeat application implementation review or certify production readiness.

## Reviewed source digests

```text
f2d25507c29bb99e7c35d04835df056d24938887cac4035570ed7fb28f73bccb  cloud/dev/scripts/deploy-relay-blue-green.mjs
e9fe2ad246d72fd0ee56677f2fa64af238f7cf361f7c2c734d3b2b2d0b271da7  cloud/dev/scripts/deploy-relay-blue-green.test.mjs
b2f25166848af0fc7c212f125e64c8f38d27eff694db7678e9275831279e52d7  .github/workflows/cloud-deploy-relay-production-director.yml
88cb6c5d1e183c10b9eb3a5584ec796ae00719b9be4b70d6e28ea48bd2c4603b  cloud/infra/terraform/relay.tf
b91c6c9977420517caf9fe194d92547df3510886eda6acff5a2dd4e2646485d8  cloud/infra/terraform/variables.tf
da2a39ecb994e196faf6756e6a105a9733081e7e7f99851b5d12f47d58b17a08  RELAY-REGION-CORRECTION-ROLLOUT.md
```

## Coordinator resolution — 2026-09-10

Resolved P2: removed the independent Terraform variable. The existing serving-revision
reader now also returns `cohort_percent` from that exact revision; Terraform uses
that value, so the audited deployment workflow owns subsequent changes. An absent
service/setting bootstraps0; invalid, duplicate or secret-backed settings fail closed.
Tests cover1/17/100 preservation and explicit0 after disable. Runbook now describes
the serving revision plus retained rollback tag, matching actual tag cleanup.

55 deployment/workflow/serving-setting tests pass, zero skipped. Terraform formatting
and actionlint (with the repository's custom Blacksmith runner declared) pass.
This resolution is coordinator verification following the independent findings;
no second independent approval of the final ownership patch is claimed.

## Independent follow-up — APPROVE the reviewed ownership fix

2026-09-10. The prior P2 and P3 findings are resolved in the inspected local source. This approval is for release tooling, not production deployment or unrelated transport behavior.

- `relay.tf:174` now gets cohort_percent from the same external serving-revision read as the regional-placement secret. The competing cohort Terraform variable is removed. A later plan reads the current serving value instead of desiring a stale0/nonzero tfvar.
- `read-relay-serving-regional-placement-version.mjs` resolves the sole100% traffic revision once and reads both settings from that revision. Literal0,1,17,100 are preserved; absent setting/service alone defaults0. Duplicate, malformed and secret-backed cohort entries fail rather than reset. The existing read path passes project explicitly and does not fetch secret values.
- Workflow deployment continues to inherit/pin cohort on both candidate and rollback. Explicit changes still require repeated exact disabled-control verification. Runbook now says serving revision plus tagged rollback revision, matching successful tag cleanup.
- Independent rerun: `ORCA_BACKGROUND_LAUNCH=1 node --test cloud/dev/scripts/deploy-relay-blue-green.test.mjs cloud/dev/scripts/read-relay-serving-regional-placement-version.test.mjs` returned **41tests passed,0failed,0skipped** (33deployment +8setting-reader). The handoff said42; this exact command currently executes41.

No new P1/P2 findings in this bounded follow-up. Terraform preservation is plan-time observation, not a lock: deployment operations must remain serialized and a saved plan must not be applied after an intervening runtime cohort change without replanning. No live plan/apply or cloud operation was performed.

Follow-up source digests:

```text
f0d2d907d3099479d574607e2e66bec448cd6d3351ce60e56a8ff7f42babc8ca  cloud/dev/scripts/read-relay-serving-regional-placement-version.mjs
57299fed3fb71583da59bf2cb4a64e06902cf9196cdd3d6150e84acb3b4720b4  cloud/dev/scripts/read-relay-serving-regional-placement-version.test.mjs
88d3b9a433bc1c1553e91fd74c59aafdf47a3955593c26020e49fb70692bb23e  cloud/infra/terraform/relay.tf
18e10fba5ef0e34278527c1ceffe527ac9a627ce64377d1cc9ad7a5572f2cbbc  cloud/infra/terraform/variables.tf
7928c84ff05aff801088d9f204c0a33388e2fed14f7778dee0e83023cc3bab07  RELAY-REGION-CORRECTION-ROLLOUT.md
```
