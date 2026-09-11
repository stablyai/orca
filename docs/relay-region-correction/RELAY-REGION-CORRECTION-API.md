# Implementation protocol and store contracts

Coordinator frozen API v1 (2026-09-10)
Contract exports in @orca-cloud/relay-contract:
RegionCorrectionRequestSchema / RegionCorrectionRequest:
 {v:1,action:'issue-window'} OR {v:1,action:'report',generation,assignmentEpoch,policyVersion:1,outcome:'conclusive',measurements:{'us-central1':number,'asia-east2':number}} OR same report with outcome:'inconclusive' and reason:string(max64), no measurements.
RegionMeasurementWindow: {generation,expiresAt,assignmentEpoch,incumbentRegion,policyVersion:1}
RegionCorrectionResponse: {v:1,window?:RegionMeasurementWindow,reportStatus?:'accepted'|'duplicate'|'stale'|'expired'|'basis-changed'}
AssignmentRequest/Response optional regionCorrection namespace; omit response unless opted-in.
RegionalRetention: {mode:'finish-existing',attemptId:uuid,sourceGeneration:positive int,sourceAssignmentEpoch:positive int}
DrainSchema optional retention:RegionalRetention (negotiated only).
RegionRestored: {attemptId:uuid,sourceGeneration:positive int,sourceAssignmentEpoch:positive int,assignmentEpoch:positive int}
Cell emits type:'region-restored' with RegionRestored only after durable rollback validation and same generation restoration.
RELAY_HOST_CAPABILITY_FINISH_EXISTING_REGIONAL_REHOME='finish-existing-regional-rehome-v1'. Header only, no HostHello extra key.
Cell supports regionalRehomeProtocol=2; both source and target must support >=2 for new optional claims.

Store APIs (director owner implements):
exchangeRegionCorrection(identity, request:RegionCorrectionRequest, assignmentEpoch:number): Promise<RegionCorrectionResponse> // assignment lock, reject changed basis, read actual region, issue fixed24h window. App invokes after assign but inside admission try; report must not write placement hint.
activateControl input optional finishExistingRegionalRehome:boolean and cellIncarnation:string; persist exact capability for returned activity id+generation+incarnation under transaction.
renewControlActivity input optional retention:RegionalRetention plus cellIncarnation:string; atomic same query exact attempt/generation/activity authority; no bypass after rollback.
regionalRetentionRollback(identity,input:{cellId,cellIncarnation,activityId,expiresAt,retention:RegionalRetention}): Promise<RegionRestored|null> // verify durable rollback newer epoch exact same live source authority and atomically grant request-start activity expiry; cell uses on applicable retained renewal rejection before closing; one-shot recovery path, no recurring query. Source validates on failure then restores session, sends region-restored. During awaited check normal closure can still win; captured authority fences apply.
Cell drainHost accepts existing input plus optional retention and sourceCellIncarnation, returns Promise<RegionalHostDrainOutcome> (deadline may return sync union). App awaits.
Worker request includes attempt.retention only if optional mode. Root owns worker/app and shared contract files; director owner owns store/database, new store modules and tests; cell owner owns registry/server/heartbeat files; desktop owner owns desktop relay directory.

Backend durable representation (implemented):
- relay_region_decisions: one row per(user_id,relay_host_id), monotonic generation, fixed expires_at, assignment_epoch, incumbent_region, policy_version, outcome pending/conclusive/inconclusive, eligible preferred_region nullable, observed_at issuance time, first report_json, deterministic cohort_bucket0..99 (SHA256 of encoded user+host). No expiry/tombstone deletion; generation never resets. Legacy preference writes remain separate and cannot overwrite evidence.
- relay_control_capabilities: exact authenticated activation activity_id,cell_id,cell_incarnation,assignment_epoch,generation,finish_existing. Activation updates same-generation advertisements and removes obsolete capability rows lacking activities.
- relay_region_retentions: immutable attempt_id/source_generation/source_activity_id; rollback_epoch nullable records authoritative newer source epoch. Presence identifies finish-existing mode. Never age-delete tombstone.
- exchange locks assignment before decision. Claim holds existing global worker row then assignment, decision, attempts/migration and activities. Both capability and decision must match current source under assignment lock. Cohort filtered before LIMIT and rechecked under lock; open migration cap8 counts existing generic and optional migrations. Emergency migration engines retain independent authority and may exceed optimization admission cap.
- retained PostgreSQL renewal remains one statement: assignment -> optional retained attempt -> migration -> activity. Exact mode/basis additionally checks current authenticated capability and current runtime incarnation. Current-assignment OR cannot authorize a retained attempt after abort.
- rollback grant input includes expiresAt (original request-start deadline), validated as future and within normal105s horizon. Transaction locks assignment then attempt then activity, checks exact durable tombstone/current runtime/current capability, and regrants only an existing source control. Returns RegionRestored only after grant; does not reacquire a missing control.
- successful registered optional refresh has no24h ceiling. No-live-target-control stops renewal of migration reservation; existing15min migration lease then bounds failed-target rollback. Unregistered target remains5min cutoff. Every visited live attempt advances updated_at for fair refresh traversal. Optional mode excluded from legacy forced age redrain/24h abort.
- Store option regionalRehomeCohortPercent 0..100; default0 for every caller. Tests enabling correction explicitly pass100. Production config also defaults0. Disable/cohort change stops new claims, not needed reconciliation.

Rollback notification delivery revision (coordinator integration review): keep a pending restoration until normal same-generation rebind. renewControlActivity accepts optional restoration:RegionRestored (mutually exclusive with retention), validates exact aborted attempt/rollback epoch/current source generation/incarnation/activity/capability in existing atomic statement. Cell extends the short grant and replays region-restored on successful renewal until rebind clears pending restoration. Do not accept obsolete retained grants via this distinct restoration branch. See .tmp/coordinator-review-notes.md for scenario and required tests.

Candidate traversal uses separate durable `last_considered_at` on the new decision table; rejected candidates rotate behind unvisited candidates without extending evidence expiry or changing observation timestamps. Claims update it only after acquiring assignment/decision authority in the existing lock order.
