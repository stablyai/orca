# Spinner rendering performance

## ELI5

Imagine a wheel that tells the front desk every time it completes a lap. The
front desk is also handling your typing. CSS already turns the wheel for us,
but React still receives its once-per-second lap notifications.

We put a day's worth of laps into one animation. The wheel moves at the same
speed, while sending one lap notification a day. Drawing visible wheels still
costs something. This removes recurring bookkeeping from the input thread; it
does not make rendering or the rest of Orca free.

## How this builds on earlier changes

| Change                                                                               | What it achieved                                                                      | Remaining cost                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [#9380](https://github.com/stablyai/orca/pull/9380): shared JavaScript clock         | Reduced frame-pipeline CPU in the original one-agent measurement                      | Wrote each spinner's style 12 times per second on the input thread                    |
| [#12359](https://github.com/stablyai/orca/pull/12359): compositor CSS rotation       | Removed those recurring JavaScript style writes; fixed the reported typing regression | React still receives CSS iteration events                                             |
| [#13987](https://github.com/stablyai/orca/pull/13987): synchronize on animationstart | Avoided a synchronous style query at every mount                                      | Steady-state animation overhead stayed the same                                       |
| This change                                                                          | Preserves both later fixes and removes almost all iteration boundaries                | Compositing, other app work, mount/reveal work, and a daily iteration boundary remain |

The historical measurements in #12359 reported 41 rings causing about 490 style
writes per second, with typing input-delay p90 of 363 ms versus 19 ms when those
writes stopped. Those are historical production measurements, not numbers from
this benchmark or a direct comparison with today's app.

## Implementation

The production change is entirely in CSS. `AgentWorkingSpinner`, its callers,
markup, border, animation-start handler, and reduced-motion behavior stay the
same. No DOM node, pseudo-element, containment boundary, timer, observer, or
JavaScript animation loop is added.

The transform travels 86,400 turns in 86,400 seconds with 1,036,800 steps: exactly
one revolution and 12 steps per second. `animationstart` sets `startTime = 0` as
before, preserving shared phase after mount and animation restart. The step
count is a timing-function parameter, not a million-entry keyframe list.

React installs delegated `animationiteration` listeners even when the component
has no iteration handler. A native 2.2-second trace of 200 isolated rings counted
400 iteration events and 800 JavaScript calls before the change, versus zero of
either with the long cycle. That trace installed no animation-event listener.
These are event dispatches, not component rerenders or 400 separate OS wakeups.

## Full-app benchmark

The opt-in Playwright benchmark launches a fresh, hidden Orca app for each
scenario. It creates real Git workspaces and seeds working statuses through the
existing renderer fixture, including in-process subagent data. It renders the
normal sidebar, virtualizer, lineage, agent rows, tabs, and terminal.

| Scenario      | Git workspaces | Root agents | Subagents | Mounted / visible rings | Layout                                       |
| ------------- | -------------: | ----------: | --------: | ----------------------: | -------------------------------------------- |
| `one-agent`   |              1 |           1 |         0 |                   3 / 3 | One working agent                            |
| `one-family`  |              1 |           2 |         4 |                   8 / 8 | All family rows expanded                     |
| `200-flat`    |            200 |         400 |       800 |                162 / 15 | Normal virtualization; 23 workspaces mounted |
| `200-lineage` |            200 |         400 |       800 |              1,401 / 15 | Expanded lineage; all 200 workspaces mounted |

Measurement-only styles switch between the original one-second cycle and the
new long cycle on the same elements. The real React root, callers, status data,
and app stay the same. The reported run alternates A/B and B/A, with four
ten-second CPU samples per variant after warmup. CPU samples use cumulative
Electron process CPU and CDP main-thread task/script/style/layout metrics. No
renderer polling, screenshots, or benchmark iteration listeners run during
those CPU windows. No samples are discarded.

Typing is measured separately using the existing paced terminal-typing probe:
64 keys at 113 ms cadence, twice per variant, after two seconds of warmup with
status traffic. Status updates arrive in groups of up to eight every 200 ms.
Keys pass through the DOM, real PTY, and xterm. A sidecar timestamps arrival at
the PTY, and a bounded terminal-buffer scan observes each echo. Missing input
or echoes fail the benchmark. Echo measurements include the 10 ms scan interval;
they do not measure native display presentation. Native animation traces also
run separately from CPU and typing samples.

The statuses are deterministic test data, not hundreds of paid model sessions.
The test exercises UI cost under agent-status traffic, not the compute or network
cost of model inference, SSH traffic, or hundreds of streaming PTYs.

## Results

CPU values are medians of four samples. "CPU ms/s" means milliseconds of
processor time used in one wall-clock second: 100 ms/s is about 10% of one CPU
core. Renderer + GPU-process CPU includes their other app work and CPU used by
the graphics process; it is not GPU hardware utilization or whole-machine CPU.
The main thread handles input and is included in renderer CPU, not extra work.
Echo p90 means 90% of sampled keys were observed within that time; ranges show
the two runs, not confidence intervals. No keys or echoes were missing.

| Scenario      | Renderer + GPU CPU ms/s, old → new | Main-thread ms/s, old → new | Echo p90 ms, old → new |
| ------------- | ---------------------------------: | --------------------------: | ---------------------- |
| `one-agent`   |                        37.0 → 38.2 |                   5.4 → 3.5 | 19 → 18–19             |
| `one-family`  |                        46.2 → 44.6 |                   7.8 → 4.4 | 17–19 → 18–19          |
| `200-flat`    |                      141.6 → 122.8 |                 28.2 → 16.3 | 26–28 → 26–28          |
| `200-lineage` |                      324.6 → 295.6 |                140.8 → 70.0 | 159–239 → 93–160       |

The consistent gain is less main-thread work: about 35%, 43%, 42%, and 50%
less in these four scenarios. Native 2.2-second traces counted 6, 16, 324, and
2,802 iteration events before, and zero in each new variant, without adding an
iteration listener. That avoided work also exists in Orca itself, independently
of the isolated fixture and CPU noise.

Total CPU was roughly unchanged in the one-worktree cases. In this run it fell
13% with normal virtualization and 9% with expanded lineage; seven of eight
paired large-case CPU samples favored the change. These percentages are not
universal: a shorter three-variant ablation measured flat-list CPU at 89.0 ms/s before and
108.0 ms/s with the long cycle, while main-thread time still fell from 26.3 to
17.4 ms/s. The repeatable main-thread reduction is stronger evidence than a
single total-CPU percentage.

Typing was similar in the small and flat-list cases. Expanded-lineage echo p90
improved in the final run, but a shorter ablation had similar before/after
latencies. No general typing speedup or statistical non-regression guarantee
is established by these short experiments.

### All CPU samples

Values are rounded to one decimal and listed by round, with no outliers removed.
The first new small-case samples were higher than their paired baselines; they
remain included. CPU and typing were sampled separately.

| Scenario      | Version | Renderer + GPU CPU ms/s    | Main-thread ms/s           |
| ------------- | ------- | -------------------------- | -------------------------- |
| `one-agent`   | Old     | 37.8, 36.2, 26.2, 39.6     | 6.5, 5.2, 4.8, 5.7         |
| `one-agent`   | New     | 53.3, 35.8, 37.5, 39.0     | 6.7, 2.8, 3.0, 4.1         |
| `one-family`  | Old     | 46.3, 46.1, 47.9, 44.6     | 7.8, 7.6, 9.8, 7.7         |
| `one-family`  | New     | 53.8, 45.4, 42.5, 43.8     | 6.8, 4.5, 3.1, 4.3         |
| `200-flat`    | Old     | 142.4, 140.8, 147.0, 136.5 | 28.3, 28.1, 32.2, 27.0     |
| `200-flat`    | New     | 122.9, 97.2, 122.7, 126.7  | 19.2, 10.7, 16.6, 16.0     |
| `200-lineage` | Old     | 317.9, 385.2, 315.9, 331.2 | 134.4, 159.6, 133.9, 147.3 |
| `200-lineage` | New     | 318.6, 256.9, 296.5, 294.7 | 89.2, 60.8, 71.6, 68.3     |

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm bench:spinners --sample-ms=5000
ORCA_BACKGROUND_LAUNCH=1 pnpm bench:spinners --verify-only --scale-factor=1
ORCA_BACKGROUND_LAUNCH=1 pnpm bench:spinners --verify-only --scale-factor=2
ORCA_BACKGROUND_LAUNCH=1 ORCA_SPINNER_BENCH=1 ORCA_SPINNER_KEYS=64 \
  pnpm test:e2e spinner-workspace-perf.spec.ts --workers=1
```

The full-app command rebuilds in `e2e` mode. For a fresh build already made with
`pnpm exec electron-vite build --mode e2e`, `SKIP_BUILD=1` reuses it. Do not reuse
an old launch-policy build. `ORCA_SPINNER_SAMPLE_MS`, `ORCA_SPINNER_ROUNDS`,
`ORCA_SPINNER_KEYS`, `ORCA_SPINNER_KEY_CADENCE_MS`, `ORCA_SPINNER_VARIANTS`, and
`ORCA_SPINNER_OUTPUT` control the experiment. `ORCA_SPINNER_CPU=0` repeats only
typing; `--grep one-agent` selects one scenario. Reports, native traces, typing
sidecars, and CDP screenshots are written under `.bench-fixtures/`. Run one
benchmark at a time, without concurrent builds or tests.

The optional `contained` variant retains the rejected offscreen experiment for
ablation. It adds `content-visibility:auto` to the existing wrapper through
measurement-only styles. It is not enabled in production or the default
benchmark comparison.

## Visual and behavioral checks

Both 1x and 2x display-density checks passed 720 ring comparisons each: 6/8 px
rings, light/dark themes, supported zoom extremes, all 12 phases, long elapsed
times, and the daily wrap. The comparison pauses each animation and sets its
`currentTime`, so the long-elapsed and daily-wrap cases exercise the deterministic
style path rather than a running compositor animation. Against that path the
tolerance is one channel level for floating-point antialias rounding. A running
animation at multi-hour ages can differ by a few channels on the ring edge — a
fraction-of-a-pixel antialias difference at large accumulated angles, not a phase
or shape change. Checks also cover shared phase, reduced motion, initial offscreen
reveal, repeated scroll-away/reveal, and `display:none` restoration.

## Limits and rejected approaches

Adding `content-visibility:auto` to the existing stationary wrapper saved more
CPU at large mounted counts, but a 1x display check found a one-pixel shift at
the minimum UI zoom. That containment change is excluded. A previous
pseudo-element version also regressed typing latency in the virtualized list.
Neither prototype's CPU or typing numbers describe the final patch.

An initial typing run used a 100 ms key cadence, which can repeatedly align with
200 ms status bursts. Follow-up runs use 113 ms, more keys, and two seconds of
warmup under status traffic. This reduces timing bias; it does not excuse a
regression. CPU measurements run separately and do not depend on key cadence.

An early isolated test suggested a 31% process-CPU reduction that a longer audit
did not reproduce. The longer isolated audit measured original 104.04 versus
long-cycle 92.32 CPU ms/s, and main-thread 10.08 versus 0.24 ms/s. A fixture with
every ring far offscreen and containment enabled could also approach idle; that
is not representative of Orca with visible animations. Neither result justifies
claiming "free spinners" or a universal CPU percentage. Virtualized, unmounted
rows already cost nothing, and this patch does not add offscreen culling.

All local measurements use an Apple M4 (10 cores), macOS, Electron 43.4.1 /
Chromium 150.0.7871.224. Native windows stay hidden and unfocused;
benchmark-only settings disable background throttling to exercise the frame
pipeline. These are not visible-window power measurements. No battery benefit
is established. Linux/Windows need their own runtime measurements. The
renderer-only change does not alter SSH execution, wire data, status semantics,
Git operations, or folder-workspace ownership.

Animated PNGs, masks, layer promotion, CSS sprites, individual `rotate`, and
containment on the rotating element were also explored. Shared images added
raster work and regressed the single-ring case; sprites reintroduced per-frame
style work. They did not meet the appearance and responsiveness requirements.
