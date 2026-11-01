# Computer-use task benchmark

Compares Orca's direct Linux AT-SPI and Windows UI Automation providers with
cua-driver 0.38.0. This does not measure the CLI, sidecar, model, or complete agent
workflows. It does not install cua-driver in Orca.

Run the `Computer-use task benchmark` GitHub Actions workflow on a branch. Native
input runs only on its disposable Windows runner or Linux Xvfb desktop. The runner
refuses to run on the developer's desktop. Keep `ORCA_BACKGROUND_LAUNCH=1`.

The first matrix covers GTK/WinForms and Electron fixtures. Editor applications,
Wayland, macOS and additional Windows control frameworks need separate coverage.
Do not generalize these results to every application on a platform.

## Measurement contract

- Baseline and candidate runtimes come from full commit SHAs, copied before the
  run. Artifacts include source hashes, cua executable hash/version, image,
  seed, complete trial plan, responses, snapshots and independent fixture states.
- Each individual trial launches a fresh target, sentinel and provider. Process
  groups on Linux and jobs on Windows contain children, including timed-out calls.
  The provider is terminated and reaped before the terminal oracle read. No retry
  follows an uncertain mutation.
- Reset carries a unique nonce bound to the fixture instance and PID. The fixture
  acknowledges after applying text, selection, logical focus, counters, combo,
  scroll and menu state. Sentinel foreground and stacking are independently checked.
- Invalid preparation executes no provider operation, is excluded from the scored
  denominator, and makes the run incomplete with nonzero exit status. A missing or
  ambiguous control after valid setup is a scored coverage failure.
- Strict selectors require a unique matching role and label. References are fresh
  before the task and after every step. There is no label-only or role-only fallback.
- Completion requires exact independent final state, including unchanged decoy text
  and exactly one click/submit. Submission handlers capture the submitted text;
  Increment handlers capture the selected color at click time. Submit tasks require
  the marker in the submission, and choose-and-click requires Blue at the click.
  Final text/color alone cannot prove those events carried the intended values.
  Raw text is never cleaned. API errors, missing final
  observations and observed interference remain separate from task completion.
- The observer starts before provider initialization and initial selector snapshot,
  and stays active through all steps, reads, shutdown and settling. No sentinel
  refocusing happens during measurement. Idle and deliberate-steal controls must pass.
- Complete tasks run without simulated user typing. Separate click and scroll probes
  type `q` into the sentinel. Event counters preserve evidence even if agent input
  selects or deletes text. Observations sample roughly every 4 ms; they cannot prove
  the absence of shorter focus/pointer/clipboard changes. X11 clipboard observations
  detect ownership changes, not all changes made by the same owner.
- Engine order rotates across rounds from a recorded seed. Use a multiple of three
  rounds for balanced positions. Default/background and explicitly requested
  foreground profiles are separate trials. Foreground can intentionally interfere.
- Comparable per-step time includes the action and an additional full no-screenshot
  observation for every provider. Raw action time is diagnostic because Orca already
  returns a snapshot with mutations. Task time includes provider startup, discovery
  and all action/read pairs. Medians include completed tasks only; failed-attempt
  durations and sample counts are separate. Diagnostic serialization and disk I/O
  happen after timing. Final independent readback after shutdown is an upper
  bound on effect time, recorded separately.
- Fatal errors, invalid setup, failed observers, unobserved completion, budget
  exhaustion or missing planned cells leave JSON evidence and exit nonzero. A valid
  observed task failure remains a benchmark result, not an infrastructure failure.

Tasks cover explicit text targeting with another field logically focused, Unicode
entry plus submit, select-all replacement plus submit, and color choice plus one
click. Interference probes remain separate from task latency comparisons.

Explicit-target typing is a native capability probe. Orca's public CLI/RPC currently
accepts typing at the focused field and does not expose an element target for text.
Failure of this probe identifies a capability to consider adding; it does not prove
a violation of the current public typing contract. Click-then-type tasks exercise
the existing sequence, although this benchmark still bypasses public transports.

The Linux Electron job also records restoration stages in `focus-probe/results.json`.
It records the AT-SPI focus acknowledgment, selected ACTIVE state, manual legacy PID
fallback, managed/native IDs, explicit singleton activation, minimized restoration
and the candidate's behavior with two same-PID windows. Managed windows include
minimized windows and exclude unmanaged helper windows.
The primary fixture publishes its native ID, checked against its PID before the probe.
Probe success establishes restoration behavior; actual text-and-submit completion
comes from the separate task results above.

AT-SPI ACTIVE is the runtime's focus authority. Global input can still race a later
focus change, and singleton accessibility/native counts do not establish an atomic
identity mapping if a window closes or the accessibility tree is stale. The probe
covers stable fixtures and detected ambiguity, not those concurrent lifecycle races.

## Headless contract checks

```sh
ORCA_BACKGROUND_LAUNCH=1 python3 -m unittest discover -s config/benchmarks/computer-use -p 'test_*.py'
```

These checks protect the historical false-success cases and process-tree cleanup.
They do not import desktop observers or generate native input.

Transports, fixtures and observers were adapted from the historical
`bench/computer-cua` prototype at `68a68ccf0f16c0a7f952d55adfe21850247b8ee9`.
Historical checkouts and result artifacts remain unchanged.
