import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'pairing-address',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  },
  {
    path: ['serve', 'stats'],
    summary:
      'Show live runtime counts (terminals split by exit evidence, browser pages of both kinds with their renderer footprint), task/agent/worker breakdowns, and host load, memory, pid and event-loop pressure with long-poll capacity',
    usage: 'orca serve stats [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Queries a running runtime (local or --environment / pairing). Does not start a server.',
      'JSON shape is a stable contract: version, runtimeId, uptimeSeconds, port, counts.{agents,tasks,terminals,terminalsUnverifiable,terminalsExited,worktrees,browserPages,browserPagesRetained,browserPageMemoryTotalBytes,browserPageMemoryMaxBytes,tasksByStatus,agentsByState,workersByTerminalState}, host.{loadAverage1m,cpuCoreCount,memoryTotalBytes,memoryAvailableBytes,memoryAvailableSource,swapUsedBytes,pids}, health.{eventLoopDelayP99Ms,longPolls}. The three breakdowns are objects with every key always present (0, never omitted).',
      'host.* is HOST-WIDE, never Orca-attributed: a runaway terminal child shows up here (#12588), so host.memoryAvailableBytes is not "what Orca left free". Compare host.loadAverage1m against host.cpuCoreCount. memoryAvailableSource is proc-meminfo (Linux MemAvailable, the real signal) or free-memory (os.freemem(), which understates availability because it excludes reclaimable page cache).',
      'Unmeasurable fields are null in JSON and n/a in human output, never 0: loadAverage1m is null on Windows, swapUsedBytes is null off Linux or without procfs, and eventLoopDelayP99Ms is null until the monitor records a sample. health.eventLoopDelayP99Ms resets on read, so each call reports the window since the previous call — that is what keeps a saturated hour from being diluted by days of idle.',
      'host.pids is the cgroup v2 pid controller (/sys/fs/cgroup/pids.current and pids.max): #18789 had 8,629 clone() calls rejected against pids.max=4096 with 44 GB still free, which neither loadAverage1m nor memoryAvailableBytes shows. It is null off Linux, on cgroup v1, and in a container with no cgroup mount; pids.max is null (unlimited in human output) for the literal cgroup value "max", never coerced to a number.',
      'health.longPolls is the runtime_busy fence made readable — total, ask, browserHost and specialized pools, each with active and cap. #19342 hit runtime_busy on a host at loadavg 4.8 and could only find the cap by unpacking app.asar, so both halves are reported: total.active against total.cap is what sheds a new long poll, and ask/browserHost are sub-pools sharing the specialized ceiling. Null when no RPC listener is serving, because the caps belong to the server, not the machine.',
      'counts.browserPageMemoryTotalBytes and counts.browserPageMemoryMaxBytes are the resident set of the renderer processes behind counts.browserPages, de-duplicated by pid because Electron may back several pages with one renderer. The max exists because #14552 was one 1.3 GB page among six, which a total alone hides. Linux only (one /proc/<pid>/status VmRSS read per pid, no subprocess): null off Linux, and null when there are no pages at all — read counts.browserPages to tell those apart.',
      'Disconnected ptys are split by evidence, never merged: terminalsExited counts the ones the owning host positively reported gone, and terminalsUnverifiable only those with no such evidence — unverifiable is not proof they exited, and it does not authorize cleanup.',
      'browserPages counts both kinds of page — client-hosted pages and the WebContents-backed pages a headless serve opens offscreen — de-duplicated by page id. browserPagesRetained is the client-hosted subset whose host is gone, so it is a subset of browserPages and not a partition: an offscreen page has no separate host to lose, so it is never retained.',
      'tasksByStatus does not sum to counts.tasks: it includes the completed/failed rows that counts.tasks excludes. agentsByState reports unknown for any agent whose turn state is not currently provable (all structured sessions, plus ptys with no live status) — unknown is never idle. workersByTerminalState covers every retained dispatch, so reclaimable/release_unknown pileups are visible without worker-list.'
    ],
    examples: ['orca serve stats', 'orca serve stats --json']
  }
]
