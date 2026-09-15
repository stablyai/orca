# Remaining release work and proposed rollout

Status: implementation and local validation; no deployment authorization used.

## Ordered release actions

1. Review the local changes/PR and CI results. Record the immutable merged commit
   and image for deployment and rollback. All directors must run the reviewed idle
   worker before enabling correction; verify mixed-version deployment behavior
   while correction remains disabled.
2. Publish the relay image and deploy the director with correction cohort0 and
   durable rehome disabled. Verify image, health, preview route, migration schema,
   pool pressure and cleanup. This requires the authorized deployment workflow.
3. Roll supporting cell images using their existing cell workflow; verify protocol3,
   correct incarnation and telemetry. Release the updated desktop normally.
   The phone protocol is unchanged; no mobile update is required for correction.
4. Validate a packaged desktop with a physical phone (foreground, actual background
   suspension, resume, quiet connection, and target failure), and existing clients
   against new cells. Run the same transport gate on Linux/Windows in CI; validate
   an actual SSH-owned terminal survives client disconnection and normal reconnect.
5. Read the authenticated aggregate preview. Estimate eligible population by
   direction; use a matching unchanged comparison cohort. Choose the initial
   cohort and record approvals before changing settings or enabling.
6. Configure the approved cohort through the existing director workflow input,
   keeping the durable control disabled during deployment. Verify the serving revision and tagged rollback
   revision, then enable through the existing regional-rehome control workflow.
7. Stop new claims on a regression while ordinary migration cleanup and recovery continue.
   Investigate existing work rather than forcing a timer-based source closure.

## Proposed numerical acceptance criteria (must be approved before enable)

These are rollout proposals, not measurements of production baseline or authorization.

- First phase:1% deterministic host cohort; global cap remains8 open migrations.
  Observe at least24h and30 completed moves. If traffic cannot supply30, extend
  observation; do not treat a small sample as success.
- Immediate stop: any optimization-induced close of an established client, admission
  reopening on ambiguous source authority, duplicated mutation, authorization bypass, or more than8
  optimization migrations admitted (pre-existing work also consumes cap).
- Reliability stop: compared with an unchanged cohort over matching15-minute
  windows, assignment/connect failure rate rises by>=1 percentage point or2x
  (require>=100 attempts in each comparison group); investigate lower-count failures
  individually. Existing production incident limits always take precedence.
- Performance acceptance: matched post-move assigned-cell control RTT improves by
  >=25ms AND>=20% median per host for at least80% of evaluable moved hosts; require
  two independent samples before and after. Identify samples using
  assignment epoch/cell identity. Log sample insufficiency as unevaluable.
- Client connection setup p95 must not regress by>10% versus its matched baseline
  after accounting for the unchanged cohort. Setup is not application command
  latency; separately record physical-phone interaction timings on validation runs.
- Expansion requires healthy registration/completion, stable reservation usage, no growing stuck-recovery backlog, and numerical criteria
  above. Continuously connected clients may postpone optimization indefinitely.

## Evidence boundaries

Local tests use real socket traffic and independent host execution, but synthetic
clock/authentication. Neither the build nor schema fixtures prove distribution,
production latency, a physical phone or a signed desktop upgrade. Separate Docker SSH tests validate
SSH-provider recovery; they are not physical mobile-to-SSH cutover evidence.
The checklist leaves these release gates open deliberately.
