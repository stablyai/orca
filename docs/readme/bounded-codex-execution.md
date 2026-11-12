# Bounded Codex execution

`worker-start --execution-policy-file <private-json-file>` uses the existing worker, request ledger and structured-session lifecycle. It currently supports local macOS folder workspaces only. The file is strict schema 1: `sourcePin`, `accountFingerprint` (`codex:<sha256>`), `model`, `effort`, `deadlineAt` (Unix milliseconds) and `access` (`read-only` or `workspace`). The explicit worker model/effort must match. The deadline must be future and within five minutes.

Use an existing undispatched task, or create a child with `--spec` and `--parent`. A prior dispatch, actor reuse, retries, remote placement, setup, forks and terminal fallback are refused. A caller UUID remains the recovery identity; inspect it rather than resending after an uncertain response.

The native child pins ChatGPT login, the default OpenAI Codex endpoint and standard service tier. It replaces inherited launch flags, disables hooks, apps, plugins, fanout and web search, removes inherited command environment and disables configured MCP servers through task-local overrides. Thread creation must report disabled MCP runtimes with empty catalogs. It uses an experimental named permission profile with one workspace root, network disabled and explicit temporary-directory denial.

Before the single input is written, the held child must report the admitted included account, model, effort, profile, workspace, sandbox and approval settings. The final synchronous check revalidates the capture and owner. A second input is refused without reacquisition. Later account or settings drift requests teardown of the exact child.

The deadline timer starts before acquisition and requests owned process teardown. A stop request is not exit proof: root and process-tree observations remain authoritative. `worker-show --settings` exports sanitized native facts only while the same owner, fence, generation and dispatch policy binding remain current. Workspace roots are labeled as observed at thread open because Codex's settings notification omits them; the one turn explicitly repeats those roots.

The runtime capability denotes protocol support, not route qualification, billing verification, successful inference or measured savings. The harness must bind its own source, admission, allowance, build and empirical evidence before promotion. Advisors, remote hosts, other platforms/providers and installed-app adoption require separate qualification.
