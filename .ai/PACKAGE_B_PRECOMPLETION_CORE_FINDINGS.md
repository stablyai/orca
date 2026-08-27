# Package B pre-completion core findings

These are read-only Control Room findings against dirty HEAD `4a0cae2626788c86522f925465aa1804f375eca1`. Resolve within the existing consolidated correction before final exact-head certification. Do not create another Run or worker.

1. Certification event semantics are still gameable.
   - `failure_recovery` currently accepts any failed/terminated Dispatch, not an actual retry/recovery transition.
   - reviewer `role_execution` accepts `start_unknown`, which does not prove execution.
   - `duplicate_prevention` accepts normal capability revocation on completion; the candidate minted PASS without a replay/duplicate attempt.
   - `pretool_acceptance` uses presence of a hook/tool row rather than an explicit accepted PreTool decision.
   - `safe_launch_acceptance` uses presence of a launch token rather than an explicit safe-launch admission event.
   - effective identity can be treated as provider-observed merely because it differs from requested, although current launch receipts are catalog/request copies and no provider provenance writer was found.
   Add bug-rejecting negative controls for each successful gaming path and require runtime-owned event-specific evidence.

2. SHA/runtime binding must not self-authorize.
   - Worker-start currently derives `currentCommitSha` from certification evidence rather than authoritative runtime build identity.
   - A packaged app cannot depend on `git rev-parse` from a repository checkout; embed/build-stamp the commit or fail closed.
   - Prove record-time and admission-time rejection for wrong SHA and wrong runtime on the exact final packaged/native-compatible build.

3. Validation lease is not yet a real serialized mutation fence.
   - Current call sites appear limited to worker start/re-engagement; an already-running worker's Orca-managed mutation/tool execution path must consult the fence.
   - RPC trusts caller-supplied owner fields and does not prove Run/Task/Dispatch/worktree identity.
   - Acquire is read-then-`INSERT OR REPLACE` without the documented `BEGIN IMMEDIATE`, so concurrent acquirers can both observe free and overwrite ownership.
   - Reject nonpositive TTL, exclude expired leases from owner lookup, prove rightful-owner-only release, deterministic expiry/crash recovery, and an actual managed mutation blocked during the lease.

4. Incremental gates must require real declared inputs.
   - Empty dependency sets and caller-declared PASS can mint a reusable receipt across SHAs.
   - Fail closed when required inputs/config/version cannot be proven; preserve exact-head binding for policy gates.

5. Batch intake must operationally enforce overlap decisions.
   - `serialize`/`merge` relations are stored, but no production launch/admission consumer was found.
   - Manifest semantic/resource claims are optional/insufficient and Run IDs need not exist.
   - Idempotency is not batch-bound: the same `batchId` can be replayed with different outcomes to enlarge the batch, and relation decisions can be overwritten. Bind an immutable manifest fingerprint and structured receipt to the batch; reject divergent replay and duplicate Run IDs before mutation.
   - Prove dangerous overlap cannot launch concurrently, safe independent outcomes can, replay is idempotent, and refusal leaves zero partial admissions.

6. GLM-5.3 is native-route supported and must not be classified `TRULY_UNSUPPORTED`.
   - Orca v1.4.190 supports the `opencode` TUI, `/hook/opencode`, session capture, and `opencode --session` resume.
   - Local OpenCode 1.18.19 lists exact model `zai-coding-plan/glm-5.3`; the SCL safe launcher and PreTool already support it.
   - `native-route-contract.ts` wrongly equates generic `AGENT_HOOK_TARGETS` omission with no hook, ignoring the OpenCode-specific plugin, and treats absence from one session-option catalog as no native route.
   Derive OpenCode truth from its native harness/plugin/session contract and remove this false policy drift.

   The full native/SCL policy read-only matrix is:
   - Opus `claude --model opus[1m] --effort high`: native launch PASS, current PreTool PASS, safe launcher PASS; exact effective Opus 5 identity still needs provider-observed proof.
   - Fable `claude --model fable --effort high`: native launch PASS, current PreTool PASS, safe launcher PASS; effective identity still needs provider-observed proof.
   - Sol `codex -m gpt-5.6-sol -c model_reasoning_effort=xhigh`: native launch PASS, current PreTool FAIL, safe launcher PASS (`BLOCKED_PRETOOL_POLICY_DRIFT`).
   - Gemini native selector `gemini -m gemini-3-flash-preview`: native harness PASS, current PreTool FAIL and safe launcher FAIL; legacy SCL aliases are accepted but their effective identity is unproven.
   - Grok `grok -m grok-4.6 --reasoning-effort xhigh`: native launch PASS, current PreTool FAIL, safe launcher FAIL (`BLOCKED_*_POLICY_DRIFT`, not unsupported).
   - GLM `opencode --model zai-coding-plan/glm-5.3 --agent scl-glm-builder --auto`: native launch PASS, current PreTool PASS, safe launcher PASS.
   Native capability must represent both structured worker-start preferences and custom-terminal-then-supervised-attach. Hook truth must include generic managed hook targets plus OpenCode's plugin hook. Current SCL consumers still contain duplicated tables and no consumer of `orchestration.routeTruth`, so `SINGLE_ROUTE_CONTRACT` remains FAIL until the derived contract actually reaches PreTool, safe-launch, admission, and retained routing.

7. Every previous candidate receipt is stale once this dirty tree changes.
   - Rebuild an isolated hook-capable candidate from the final committed SHA.
   - Re-run all seven live proofs and the full prior core smoke on that exact runtime.
   - Specifically include terminal output with no hook => NOT_STALLED, then no authoritative activity past threshold => STALLED; and failed builder => zero review Task/Dispatch/session.

Return worker_done only after the exact final head is clean, affected/full tests pass, all live receipts bind to it, native Orca remains unchanged, and the report names exact proof artifacts.
