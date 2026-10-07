# OMP CLI prompt routing and evidence limits

The source change routes a positively recognized foreground OMP process through Orca's existing agent-prompt writer. It does not establish that the historical missing-submit defect is fixed. The installed product runtime is unchanged.

## Mechanism

`terminal.send` selects `sendTerminalAgentPrompt` only for an explicit agent prompt with text, Enter, no interrupt, a desktop client, and a successful `isTerminalRunningSettledPromptAgent` check. That check previously admitted Claude and Codex but excluded OMP.

Excluded OMP prompts reached `RuntimeTerminalWriter`, which wrote unframed text in UTF-8 chunks of at most 16,384 bytes and later wrote CR separately. The existing `writeTerminalAgentPrompt` already recognizes OMP and writes bracketed paste plus CR in one PTY-controller call. The change admits OMP at the selector without changing process recognition, presence validation, or handle binding.

Bare Enter, text-only input, interrupts, mobile input, unknown foreground processes, and stale launch metadata retain their existing selection rules. OMP submission observation remains `unsupported`. The change adds no retry, recovery Enter, truncation, submit delay, or synthetic `turn_started` stage. It changes no wire field and makes no local-Git-worktree assumption.

## Observations under OMP 18.6.1

One public Orca CLI baseline send of 27,000 bytes produced the actual reply `ACK_OMP_FIX_20261006_BASELINE`. Its receipt contained only `input_accepted`, with unsupported provider and observation. The receipt alone did not prove that reply.

Six paired comparisons used fresh OMP-pstack receivers in the approved fixture checkout. The comparison called the extracted selector and writer implementations against real OMP PTYs. It captured the writes issued at that boundary, not the historical PTY input or the child's individual stdin reads. Baseline and candidate received the same payload in each pair.

| Payload and independent control                | Baseline PTY-call byte lengths | Candidate PTY-call byte lengths |
| ---------------------------------------------- | ------------------------------ | ------------------------------- |
| 4,800 bytes, 60 ASCII lines, final LF          | 4,800; 1                       | 4,813                           |
| 17,000 bytes, 60 ASCII lines, final LF         | 16,384; 616; 1                 | 17,013                          |
| 27,000 bytes, 60 ASCII lines, final LF         | 16,384; 10,616; 1              | 27,013                          |
| 27,000 bytes, one ASCII line, final LF         | 16,384; 10,616; 1              | 27,013                          |
| 27,000 bytes, 60 Unicode lines, final LF       | 16,384; 10,616; 1              | 27,013                          |
| 27,000 bytes, 60 ASCII lines, no final newline | 16,384; 10,616; 1              | 27,013                          |

Every completed comparison recorded one `before_agent_start`, one `agent_start`, and the exact nonce acknowledgement. Candidate writes started with `ESC[200~` and ended with `ESC[201~` plus CR. All six candidate prompts matched the full fixture after OMP's observed trailing-whitespace trim. The baseline 27KB ASCII and Unicode multiline cases each inserted one U+0020 inside the received prompt. That content difference is observed, but its parser cause is not established.

The first CRLF baseline reached startup before interruption, with no framing or acknowledgement result and no candidate run. Another interrupted one-line baseline recorded a start but no final acknowledgement. Neither interrupted receiver received further input. A later one-line pair completed in fresh receivers. Those later results do not complete either interrupted record.

The old submission failures are not reproduced by these successful baseline cases. Payload size, LF, Unicode, and unsupported observation are insufficient explanations on their own. The relationship between raw framing and the historical missing submit remains a hypothesis.

## Separate CRLF control under OMP 18.7.0

Two fresh receivers completed a 27,000-byte, 60-line CRLF control. Both routes recorded exactly one `before_agent_start`, `agent_start`, nonce response, and `agent_end`. The baseline PTY calls contained 16,384, 10,616, and 1 byte; the candidate used one 27,013-byte bracketed-paste frame with CR. No resend or recovery Enter occurred.

Neither received prompt preserved the original CRLF bytes. The candidate matched the fixture after CRLF-to-LF conversion and trailing-whitespace trim. The baseline had one additional U+0020 at UTF-16 offset 21,458. This control uses a different binary and does not complete the interrupted 18.6.1 run.

## Verification boundary

The isolated comparison is not candidate Orca CLI end-to-end validation. It substitutes runtime bookkeeping and presence responses around the extracted methods. It does not exercise Electron, the real PTY provider, RPC transport, process-table detection, SSH transport, or Windows ConPTY.

A separate extracted-selector smoke passes for recognized OMP, confirmed OMP command lines, refused presence, stale OMP launch metadata, and missing PTY binding. Bun's transpiler accepts the changed TypeScript files. Neither check replaces the runtime suite.

The permanent consumer regression invokes the real `terminal.send` handler with the real test runtime and captures its PTY writes. It requires one intact bracketed frame with CR and an honest unsupported receipt. Existing identity tests now include OMP and stale OMP launch metadata.

The initial focal Vitest invocation failed before execution because dependencies were absent. The initial typecheck was interrupted by SIGTERM. During publication preparation, the configured setup completed with pnpm 12.0.0. Those initial failures remain separate from later validation results.

On the release-based checkout, Node and CLI typechecks, the changed-code quality gate against its initial HEAD, and Electron-Vite compilation passed. CLI compilation and its package-boundary verification passed without running the global CLI installer. Runtime fragments are imported by `src/main/runtime/orca-runtime.test.ts`; passing fragment paths alone does not execute them under the default Vitest include pattern.

The release-based runtime aggregate and terminal-prompt RPC suites passed with 1,306 tests and one skip, including real-handler consumer controls for literal raw text and bare Enter without prompt framing. Six supporting identity, permission, prompt-transport, and receipt suites passed with 152 tests. The initial candidate aggregate had two lineage failures; after removing an unrelated terminal-inventory query from the new consumer fixture, the complete candidate aggregate passed. The initial-HEAD aggregate passed with 1,301 tests and one skip, so those initial candidate failures are not reported as proven base failures.

The isolated Electron CLI/runtime attempt stopped before readiness or receiver creation. Chromium reported a misconfigured SUID sandbox helper. No prompt was sent. Fixing host-level sandbox ownership or permissions requires separate authorization; disabling the sandbox is not evidence of a successful candidate run.

## Validation on main

The correction was reconciled onto main without its divergent release history. The configured setup used pnpm 12.8.1. `pnpm tc` and the eight selected runtime, RPC, identity, permission, transport, and receipt suites passed with 1,508 tests and one skip. The changed-code quality gate against that main base passed with no new findings.

`pnpm build:orcad` built the Node-only runtime and verified zero Electron imports. Local CLI compilation and its package-boundary check passed without the global installer. The supported Node path avoids Electron's sandbox but does not validate Electron startup.

A candidate delivery check must pair the compiled CLI explicitly with an isolated orcad data root, launch one fresh OMP receiver with the assigned profile, and require a rendered `--screen` read plus a satisfied idle wait before one send. Preserve actual input bytes and received content, exact nonce response, and one `agent_start` and `agent_end`. Neither a ready server nor an unsupported receipt proves a turn. A Node Linux pass does not prove Windows, macOS, SSH, automatic handoff routing, or the historical submit defect.

## Evidence and remaining work

The unpublished evidence packages contain CLI receipts, rendered screens, payloads, PTY captures, lifecycle events, write hashes, normalized-content comparisons, and interrupted-run records. Raw reports and private paths are not part of this source change. Comparison scripts launch real model turns and must not be rerun as uncertain-delivery recovery.

Before claiming the historical defect fixed, obtain an innocuous failing-before and passing-after submit reproduction. Publication also requires the consumer suite, typecheck, build, and an isolated candidate CLI/runtime run. Do not patch or restart the product runtime, resend an uncertain prompt, or use recovery Enter to turn an incomplete initial-delivery test into a pass.
