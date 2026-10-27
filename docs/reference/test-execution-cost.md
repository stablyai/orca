# Test execution cost

On macOS/Linux, the existing package Vitest/Playwright commands use the vendored affected selector and host gate. Native runtime preparation runs inside the same gate. Use `TEST_BASE=<commit>` for a baseline or `TEST_COST_TARGETS='["tests/e2e/example.spec.ts"]'` for an exact failed-file retry. Missing baselines fail closed.

Full suites run once per merge batch with `TEST_GATE_FULL=<reason>`; identical revision/command repeats require `TEST_GATE_RERUN=<reason>`. Failures should rerun only the failed files. `sh config/scripts/test-cost/test_gate.sh report` reports duration and budget overruns from `~/.claude/locks/test-gate.log`. `.test-gate.json` starts with a 600-second warning budget; it is an observation threshold, not a measured product-suite promise.

Full E2E workflow runs require a reason before build; the manually triggered release workflow supplies its release tag as the reason. Scheduled full E2E runs are disabled.

Native Windows runs the same installed CLI and existing native-runtime preparation with unchanged arguments. Windows currently has no host gate, repeat ledger, or affected default through this dispatcher. A Windows lock/process-tree implementation remains separate work; no POSIX dependency is imposed on Windows CI.

Native changed-file graphs can still select many tests when a shared import changes. Playwright import graphs do not encode every black-box app-to-E2E relationship; specify the affected E2E files explicitly for those changes. Custom Node orchestration/benchmark scripts are outside this direct-runner dispatcher and retain their existing behavior.
