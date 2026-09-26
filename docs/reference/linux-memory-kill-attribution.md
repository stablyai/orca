# Reading a Linux SIGKILL in a crash report

A Linux renderer that dies with `reason=killed exitCode=9` was sent `SIGKILL` by
something. The crash report used to carry only `/proc/meminfo` — host-wide free
memory and swap — which answers a question nobody asked. Every killer below can
fire while `systemMemoryAvailableMB` is in the gigabytes and swap is untouched,
so that field alone cannot name any of them.

Three v1.4.200 field reports are the worked examples, all on Arch:

| Report     | What it showed                                                         |
| ---------- | ---------------------------------------------------------------------- |
| `2ea53f9c` | Lone renderer exit 9. 20518 MB available, swap 64009/64009 — 100% free |
| `ad185d76` | Renderer exit 9. 6471 MB available, swap 31351/31351 — 100% free       |
| `181e8e36` | Renderer exit 9, and a separate GPU exit 9 **9m 04.9s earlier**        |

That headroom falsifies the **host-wide** kernel OOM killer and nothing further:
a cgroup-scoped one fires on our own or an ancestor slice's `memory.max` with
the machine's spare gigabytes untouched, and no field in these reports could see
it — which is what check 1 below now reads. `181e8e36` is two single-process kills, not one
whole-cgroup kill: the `process_gone_suppressed` GPU crumb is at
`22:29:32.397Z` and the renderer report at `22:38:37.276Z`, so they are not
co-timed and nothing links them beyond the host. And in all three
Orca's **main** process survived and stayed the reporter — already up 43 m
(`2ea53f9c`), 11 h (`ad185d76`) and 3 h 11 m (`181e8e36`) by
`mainProcessStartedAt`, and `processMetricsBrowserCount: 1` in the post-death
sample — which is not what a whole-cgroup kill leaves behind.

That last point is why `systemd-oomd` is a candidate here and not a conclusion:
it kills the whole cgroup, and the surviving main process argues against it for
these three. Nothing in the report could confirm or exclude it either way, which
is the gap these fields close — they are for **distinguishing** the killers
below, not for ratifying one that was picked in advance. All three were closed
unattributed.

## The killers

Splitting the kernel OOM killer by scope is the point: only the host-wide one is
falsifiable from `/proc/meminfo`, and the cgroup-scoped one looks identical to an
outside `kill -9` in every field the report used to carry.

| Killer                           | Fires on                                         | Host free memory at the time |
| -------------------------------- | ------------------------------------------------ | ---------------------------- |
| Kernel OOM killer, host-wide     | An allocation the machine cannot satisfy         | Near zero                    |
| Kernel OOM killer, in our cgroup | An allocation past a `memory.max` above us       | Can be gigabytes             |
| `systemd-oomd`                   | PSI memory **stall**, sustained                  | Can be gigabytes             |
| Something else                   | A person, a supervisor, a sandbox, the OOM score | Anything                     |

`systemd-oomd` is default-enabled on Arch and Fedora. It watches a cgroup's
`memory.pressure` and kills the **whole cgroup** when `full avg10` stays above
its limit (50–60% by default) for `DefaultMemoryPressureDurationSec` (30 s).
Stall means time spent waiting on memory — reclaim, refault, swap-in — which a
machine with plenty of nominally free memory can do continuously.

## The fields

Emitted only on Linux, only when readable, and omitted entirely rather than
reported as zero when they are not. Each appears twice: once for the reading
taken at process-gone, and once as `systemMemoryPreGone*` for the sample taken
up to 10 s before it (see `pre-gone-host-memory.ts`).

| Field                                                | Source                                             |
| ---------------------------------------------------- | -------------------------------------------------- |
| `systemMemoryCgroupMaxMB` / `HighMB`                 | lowest `memory.max` / `memory.high` in the chain   |
| `systemMemoryCgroupCurrentMB`                        | our own cgroup's `memory.current`                  |
| `systemMemoryCgroupCeilingCurrentMB`                 | `memory.current` where the binding ceiling is set  |
| `systemMemoryCgroupOomKillCount`                     | `memory.events` `oom_kill`                         |
| `systemMemoryCgroupMaxEventCount` / `HighEventCount` | `memory.events` `max` / `high`                     |
| `systemMemoryCgroupChainReachesRoot`                 | whether the walked chain ended at the machine root |
| `systemMemoryStall{Some,Full}Avg{10,60}Pct`          | `/proc/pressure/memory`                            |
| `systemMemoryCgroupStall{Some,Full}Avg{10,60}Pct`    | the cgroup's `memory.pressure`                     |

Both ceilings are read over **our cgroup and every visible ancestor**, lowest
wins, because that is what the kernel enforces. A `snap set-quota --memory`
slice, a `MemoryMax=` on `user.slice` and a Kubernetes pod cgroup all sit ABOVE
the unit we run in, and our own `memory.max` reads `max` under every one of
them. Where the binding ceiling is an ancestor's it is shared with our siblings,
so `CgroupCurrentMB` — ours alone — is not the number to hold against it;
`CgroupCeilingCurrentMB` is, and it appears only in that case. The two event
counters stay at our own level: an ancestor hitting its `max` increments the
ancestor's counter and not ours, so a zero there does not clear an ancestor
ceiling. (`oom_kill` is not affected — the kernel credits an OOM kill to the
victim's cgroup and every cgroup above it, whichever level's limit fired.)

An absent row means "could not measure", never "calm" — with one exception to
read carefully: `memory.max` and `memory.high` read the literal string `max`
when no ceiling is set, and that is reported as an absent `CgroupMaxMB` /
`CgroupHighMB`, not as a number. So the ceiling fields alone cannot separate "no
ceiling" from "unreadable", and it takes two fields to close that:

- `systemMemoryCgroupCurrentMB` present means our own cgroup was resolved and
  read, so the missing ceiling really is unlimited **at the levels we could
  see**. No `Cgroup*` field at all means nothing was measurable.
- `systemMemoryCgroupChainReachesRoot` says how far "the levels we could see"
  went. `true` means the walk ended at the machine's own root cgroup, so an
  absent ceiling is absent over every ancestor. `false` means the cgroup mount
  root is itself a cgroup — we are inside a cgroup namespace — and a
  `memory.max` on the pod cgroup or on the slice hosting the container is
  enforced on us and **unreadable from in here**. An absent ceiling beside a
  `false` never clears check 2 below.

cgroup v1 is not read at all: its limit is not resolvable from
`/proc/self/cgroup` without mount parsing, and a half-right ceiling is worse than
none.

## How to attribute a kill

Read the pre-gone and gone-time pair, in this order.

1. **Did `systemMemoryCgroupOomKillCount` step up across the death?**
   `systemMemoryPreGoneCgroupOomKillCount` 3 → `systemMemoryCgroupOomKillCount` 4
   is the kernel OOM killer killing a task in our cgroup. The kernel credits the
   victim's cgroup whichever limit fired, so a step covers the host-wide killer
   too: split the two on `systemMemoryAvailableMB` (near zero for host-wide,
   gigabytes for a `memory.max` above us). This is the only decisive datum; an
   absolute count on its own proves nothing, because the cgroup may have OOMed
   an hour ago. Unchanged rules the kernel OOM killer out only when
   `systemMemoryPreGoneSampleAgeMs` is comfortably above event delivery — a
   second or more. The pre-gone sample is a free-running 10 s tick, so a
   near-zero age means it may itself have landed after the SIGKILL, and the
   step is then inconclusive rather than absent.
2. **Was `systemMemoryCgroupMaxMB` (or `HighMB`) set, with the usage near it?**
   A ceiling below host RAM means the machine's spare memory was never available
   to us. This is the answer for a systemd unit with `MemoryMax`, a Flatpak or
   snap sandbox, or a container. Hold it against `CgroupCeilingCurrentMB` where
   that field is present: the ceiling is then an ancestor slice's, and our own
   `CgroupCurrentMB` can sit far below it while the slice is at its limit. No
   ceiling clears this check only when `systemMemoryCgroupChainReachesRoot` is
   `true`; on a `false` the binding ceiling may sit above the namespace root,
   where nothing in the report can see it, and check 1 is then the only reading
   that still catches a hard cap (the kernel credits the OOM kill to our own
   cgroup whichever level's limit fired).
3. **Was `systemMemoryPreGoneCgroupStallFullAvg10Pct` high with memory free?**
   That is the `systemd-oomd` signature, not yet a verdict. Read the **pre-gone**
   value: PSI decays, and the gone-time reading is taken after the corpse
   released its pages, so it routinely understates the stall that caused the
   kill. Then cross-check the scope: oomd kills the **whole cgroup**, so a
   surviving main process (`processMetricsBrowserCount: 1` after the death) is
   evidence against it however high the stall reads. Corroborate with
   `journalctl -u systemd-oomd` on the reporting host if it is reachable.
4. **All three quiet, plenty of memory, and a sibling process also exit 9?**
   Only co-timed sibling deaths — seconds apart, not minutes — indicate a
   whole-tree kill from outside: a supervisor, a session teardown, `pkill`.
   Compare the crumb timestamps before concluding it: two exit 9s minutes apart
   in one session (`181e8e36`: 9m 04.9s) are two separate single-process kills,
   and each still has to be attributed on its own. Where the deaths really are
   co-timed, do not spend the investigation on memory.

## The summary label

`systemMemoryPressureSignal` already carried `mem-available` for every Linux
reading with a `MemAvailable` field. That value keeps exactly its old meaning;
two more specific values now sit beside it:

- `mem-available-cgroup-capped` — a cgroup ceiling below host RAM, so
  `systemMemoryAvailableMB` describes memory we could never have had.
- `mem-available-stalled` — `full avg10` at or above
  `MEMORY_STALL_HIGH_AVG10_PERCENT` (30%, deliberately under oomd's trip point,
  because the reading is taken after the kill and is already decaying). Read
  from the cgroup's own `memory.pressure` whenever that is present, and only
  from the host file when it is not: a sibling thrashing the machine while our
  cgroup stays calm did not kill us.

A ceiling outranks stall, because the ceiling explains the stall as well as the
kill. Both keep the `mem-available` prefix, so a reader matching the family by
prefix is unaffected and one matching the old exact value at worst loses the
refinement — see [remote-wire-compatibility.md](./remote-wire-compatibility.md).
The label is a summary; the numbered checks above are the attribution, and the
raw fields stay readable whatever the label says.

## Where the code is

- `src/main/crash-reporting/linux-cgroup-memory-limit.ts` — cgroup v2 resolution
  and `memory.*` reads. Probes both the path from `/proc/self/cgroup` and the
  mount root, because a cgroup namespace mounts our own cgroup at the root, then
  walks that cgroup's ancestors for the ceiling the kernel actually enforces.
  `memory.current` exists on non-root cgroups only, so a readable one at the
  mount root is what marks that walk as namespace-bounded.
- `src/main/crash-reporting/linux-memory-pressure-stall.ts` — PSI parsing.
- `src/main/crash-reporting/system-memory-details.ts` — field naming and label.

Both readers are platform-guarded, swallow every read failure, and return
`undefined` rather than a row of zeroes. PSI is missing on kernels without
`CONFIG_PSI` and on most WSL2 kernels; cgroup files are missing on hardened
hosts. That is a normal answer here, not an error to report.
