# Windows signing without occupying a runner during approval

Status: implementation proposal; production signing behavior is unchanged.

## Measured cost

In [release run 33821033674](https://github.com/stablyai/orca/actions/runs/33821033674)
(September 4, 2026), the Windows job took 21m56s. The inner-binary download step
took 13m19s and the installer download step took 40s: 13m59s, or 64% of the job,
was spent in the signing download/wait steps. These durations include the
download itself, so they are an upper bound on removable idle time, not a
prediction of net savings after transferring state between jobs.

`release-cut.yml` submits both requests with `wait-for-completion: false`, but
then invokes `Get-SignedArtifact` on the same Windows runner with one-hour and
four-hour completion timeouts. The six-hour job timeout accommodates both
waits. Changing the submission flag again, polling less often, or running the
wait inside a container does not release the runner slot.

This is runner occupancy, not a billing estimate. Standard GitHub-hosted
runners in a public repository may be free; removing the waits still releases
concurrency for other work. Check actual billing before assigning dollar savings.

The same release also occupied an Ubuntu runner for 11m38s while
`run-release-mac-build-workflow.mjs` waited on the isolated macOS workflow.
That is a separate orchestration optimization. Windows development-channel
builds deliberately ship unsigned and have no SignPath wait to remove.

## Proposed execution graph

Keep all Windows stages in the original `release-cut.yml` run to preserve the
current SignPath GitHub artifact provenance boundary:

1. `build-windows` builds and uploads the unpacked app, original installer,
   updater metadata, and inner-signing manifest. It submits the inner request,
   sends the existing notification, exposes the request ID, and finishes.
2. `package-windows` depends on that job and uses a protected environment named
   `windows-inner-signing`. Its runner is allocated only after GitHub approval.
   It restores the exact build, downloads the signed binaries with a short,
   bounded completion wait, applies the existing signature restoration and
   signed `elevate.exe` cache replacement, builds the NSIS installer, uploads it,
   submits the second signing request, notifies approvers, and finishes.
3. `finalize-windows` depends on packaging and uses a second protected environment
   named `windows-installer-signing`. After approval it downloads the signed
   installer, regenerates its blockmap and `latest.yml`, runs existing outer and
   inner signature checks, uploads evidence, and uploads the assets to the draft.
4. `publish-release` depends on finalization as well as the existing Linux, macOS,
   and blocking release gates. It remains the only job that publishes the draft.

The approver signs in SignPath, waits for that request to finish, and then
approves the corresponding pending GitHub job. Each notification should link
to both places and explain the order. GitHub approval is an extra action;
approving in SignPath alone does not release an environment gate.

## Required configuration

The repository environments were inspected through the GitHub API on
September 5, 2026. Neither Windows environment exists. `adhoc-mac-build` has no
protection rules; it cannot be reused as an approval gate. No SignPath callback
handler was found in the repository's workflows, scripts, application, or cloud
code.

Before enabling the graph:

1. Create both environments in repository Settings → Environments.
2. Add the release approvers as required reviewers for each environment. Decide
   whether a release initiator may approve their own job, and configure that
   consistently with the existing SignPath policy.
3. Restrict deployment branches to the trusted refs used to dispatch release
   workflows, and check that the release workflow's ref passes the restriction.
   The workflow ref and the checked-out release tag are different concepts.
4. Read back both environments through the API and verify that
   `required_reviewers` rules exist before changing the release graph. Merely
   referring to a new environment name in YAML can create an unprotected
   environment and silently leave the wait on the runner.
5. Add a preflight assertion for those rules so accidental removal fails before
   any signing request is submitted. Verify the API access required for this
   assertion using the release workflow's token; do not assume an administrator's
   local `gh` access proves workflow-token access.

An automatic alternative requires a SignPath completion callback and an
authenticated integration that releases the corresponding deployment gate.
Confirm the Foundation plan supports the necessary callback before choosing
that architecture. Do not introduce a long-running GitHub polling job as the
callback substitute: it would continue occupying a slot.

## State and failure contracts

- Use artifacts from this exact run and attempt, with a manifest containing the
  tag, tag commit SHA, workflow SHA, request IDs, artifact IDs, and SHA-256 hashes.
  Artifact names alone are insufficient. Preserve the original unsigned
  installer for the existing inner-signing fallback.
- Restore `dist/win-unpacked`, the staging list, the installer, and updater
  metadata as one checkpoint. Use an archive to preserve the tree. Do not ship
  a fresh rebuild of the app after approving a different binary tree.
- Each new Windows runner needs the pinned Node/pnpm toolchain, build
  dependencies, SignPath module, and electron-builder tool cache. The second
  runner must populate the NSIS cache before replacing `elevate.exe`; the old
  code assumes the first installer build already populated that cache.
- Retain checkout-from-tag behavior and the existing support for release tags
  that predate the composite action. Explicitly restore new orchestration code
  from the workflow SHA when necessary.
- Preserve the rule that rerunning a workflow never submits a new signing
  request. A resume must consume the recorded request and artifacts. Test failed
  stage reruns, whole-workflow reruns, and missing/expired checkpoints separately.
- Keep installer signature checks blocking. Keep inner verification evidence
  and its current warning-only policy unless changed in a separate decision.
- Resolve the current one-hour inner-signing fallback deliberately: an
  environment approval can remain pending longer than one hour and rejection
  skips dependent jobs. It cannot reproduce the existing automatic timeout
  fallback by itself. A first migration should explicitly document the new
  manual release/cancellation behavior; silently treating rejected approval as
  permission to ship is not acceptable.
- Keep the release-wide concurrency lock while the graph waits, preventing
  another release from overtaking this draft. This saves worker occupancy, but
  does not shorten the serialized release queue's human approval time.

## Validation before production

First adapt `windows-signing-rehearsal.yml` to exercise the same staged code
using the auto-approved test-signing policy. Then run a manual rehearsal with
the protected environments and confirm that pending approval has no allocated
Windows runner. Verify signed bytes through the existing extraction-based
installer checks, not only the outer installer signature.

Cover approval before SignPath completion, rejected approval, missing signed
files, changed checkpoint hashes, lost checkpoints, expired artifacts, failed
packaging, and stage reruns without duplicate submissions. Confirm no release
becomes public until all platform and signature gates pass. Compare transferred
artifact/setup time with the original 13m59s wait sample to measure net savings.

A separate `workflow_dispatch` continuation can avoid environment provisioning,
but changes this design substantially: the original release run finishes,
workflow-level concurrency no longer protects the pending draft, and SignPath
must accept artifacts assembled from a prior run. That option needs a durable
release state machine and provenance validation before production use; it is
not a drop-in replacement for the two download steps.
