# Resource Manager memory metrics

Resource Manager reports two different kinds of memory data. Process totals describe Orca and
locally managed terminal processes; host totals describe the machine running Orca. They are not
interchangeable.

## Process memory

Each snapshot declares one `processMemoryMetric`:

| Platform     | Metric        | Source                                                     |
| ------------ | ------------- | ---------------------------------------------------------- |
| macOS, Linux | `rss`         | `ps` resident set size                                     |
| Windows      | `working-set` | CIM `WorkingSetSize`, with a Typeperf working-set fallback |

Orca walks each registered local PTY subtree and claims every PID at most once. App, session,
worktree, history, and snapshot memory values are sums of those per-process samples.

RSS and working set are not unique physical-memory measurements. Shared pages can appear in more
than one process, and macOS can count the same resident page through multiple mappings in one
process. A sum can therefore exceed physical RAM. Product copy and diagnostics must identify the
metric as a sum and must not present it as a percentage of system RAM.

Remote SSH and relay sessions do not receive invented local samples. They remain unavailable until
the executing host supplies resource data. Folder workspaces use the same registered-PTY
attribution as Git worktrees.

## Host memory

`HostMemory` keeps immediate free memory separate from memory available without material pressure:

- `freeMemory` is Node's host free-memory value.
- `availableMemory` is the best bounded platform value.
- `usedMemory` is `totalMemory - availableMemory`.
- `memoryUsagePercent` is derived from `usedMemory`.
- `availableMemorySource` identifies how availability was measured.

The sources are:

| Platform | Preferred source                          | Fallback         |
| -------- | ----------------------------------------- | ---------------- |
| macOS    | `memory_pressure -Q` available percentage | Node free memory |
| Linux    | `/proc/meminfo` `MemAvailable`            | Node free memory |
| Windows  | Node free memory                          | Node free memory |

This percentage describes host availability. It is not derived from the summed process metric.

## Bounded collection

Resource Manager polls while its popover is open, so every snapshot must remain bounded under a
large process tree. macOS `footprint` provides a more physical process metric, but collecting it
across dozens of processes is too expensive for this path. A future physical-footprint backend
must use a bounded host API or helper and declare a distinct metric before product copy treats it
as physical memory.
