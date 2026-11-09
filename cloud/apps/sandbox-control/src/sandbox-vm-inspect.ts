// Read-only probes the control plane runs in a VM: live metrics (status panel, OOM banner) and the
// git metadata an archived workspace shows. Fixed scripts compiled into the Worker (never user
// input), so they work on every golden image without a rebuild. Output is one JSON line, parsed strictly.
// Bash `\${...}` is escaped in these templates; `${CONST}` interpolates the TypeScript constants.
import { z } from 'zod'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'

const PROJECT = '/vercel/sandbox/project'

/**
 * CPU from two /proc/stat samples 250 ms apart, memory from /proc/meminfo, disk for the project
 * volume, uptime, and OOM: the kernel's oom_kill counter (/proc/vmstat, readable unprivileged) plus
 * the last killed process name from dmesg when sudo allows it.
 */
export const METRICS_SCRIPT = String.raw`
set -u
cpu() { awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print t, idle}' /proc/stat; }
read t1 i1 < <(cpu); sleep 0.25; read t2 i2 < <(cpu)
dt=$((t2-t1)); di=$((i2-i1)); [ "$dt" -gt 0 ] || dt=1
cpu_pct=$(( (100*(dt-di)) / dt ))
mem_total=$(awk '/^MemTotal:/{print $2*1024}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/{print $2*1024}' /proc/meminfo)
read disk_total disk_used < <(df -B1 --output=size,used ${PROJECT} / 2>/dev/null | sed -n 2p)
uptime_s=$(awk '{printf "%d", $1}' /proc/uptime)
oom=$(awk '/^oom_kill /{print $2}' /proc/vmstat 2>/dev/null); oom=\${oom:-0}
victim=$(sudo -n dmesg 2>/dev/null | grep -oE 'Killed process [0-9]+ \([^)]{1,64}\)' | tail -n 1 | sed -E 's/.*\((.*)\)/\1/' | tr -cd 'A-Za-z0-9._+-' | head -c 64)
orcad=false; pid=$(cat "$HOME/.orca-sandbox/orcad.pid" 2>/dev/null || echo 0); [ "$pid" -gt 1 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null && orcad=true
load=$(awk '{print $1}' /proc/loadavg)
printf '{"cpuPercent":%d,"cpus":%d,"load1":%s,"memTotalBytes":%d,"memUsedBytes":%d,"diskTotalBytes":%d,"diskUsedBytes":%d,"uptimeSeconds":%d,"oomKills":%d,"lastOomVictim":%s,"orcadAlive":%s}\n' \
  "$cpu_pct" "$(nproc)" "$load" "$mem_total" "$((mem_total-mem_avail))" "\${disk_total:-0}" "\${disk_used:-0}" "$uptime_s" "$oom" \
  "$( [ -n "$victim" ] && printf '"%s"' "$victim" || printf null )" "$orcad"
`.replaceAll('\\${', '${')

export const VmMetricsSchema = z
  .object({
    cpuPercent: z.number().int().min(0).max(100),
    cpus: z.number().int().min(1),
    load1: z.number().min(0),
    memTotalBytes: z.number().int().min(0),
    memUsedBytes: z.number().int().min(0),
    diskTotalBytes: z.number().int().min(0),
    diskUsedBytes: z.number().int().min(0),
    uptimeSeconds: z.number().int().min(0),
    oomKills: z.number().int().min(0),
    lastOomVictim: z.string().max(64).nullable(),
    orcadAlive: z.boolean()
  })
  .strict()

export type VmMetrics = z.infer<typeof VmMetricsSchema>

const MAX_TREE = 2000
const MAX_CHANGED = 300
const MAX_COMMITS = 20
/** Under the provider's 256 KiB command-output cap, with room for the stream framing. */
export const MAX_OUTPUT_BYTES = 200 * 1024

/**
 * Archive metadata for every git checkout in the project (the repo plus its worktrees): branch,
 * head, upstream ahead/behind, last commits, uncommitted changes and a capped file tree. Built
 * with git's own porcelain output, JSON-escaped by node (always present in the image).
 */
export const ARCHIVE_SCRIPT = String.raw`
set -u
cd ${PROJECT} 2>/dev/null || { echo '{"checkouts":[]}'; exit 0; }
node="$(find /opt/orca/runtime/runtimes -type f -name node 2>/dev/null | head -n 1)"; node=\${node:-node}
git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}' > /tmp/orca-archive-wt || true
[ -s /tmp/orca-archive-wt ] || echo ${PROJECT} > /tmp/orca-archive-wt
"$node" -e '
const { execFileSync } = require("child_process")
const fs = require("fs")
const run = (cwd, args) => { try { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 << 20, timeout: 8000 }).trim() } catch { return "" } }
const lines = (s) => s ? s.split("\n") : []
const checkouts = fs.readFileSync("/tmp/orca-archive-wt", "utf8").split("\n").filter(Boolean).slice(0, 20).map((dir) => {
  const counts = run(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]).split(/\s+/)
  const tree = lines(run(dir, ["ls-files", "--cached", "--others", "--exclude-standard"]))
  return {
    path: dir,
    branch: run(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || null,
    head: run(dir, ["rev-parse", "HEAD"]) || null,
    upstream: run(dir, ["rev-parse", "--abbrev-ref", "@{upstream}"]) || null,
    behind: counts.length === 2 ? Number(counts[0]) : null,
    ahead: counts.length === 2 ? Number(counts[1]) : null,
    commits: lines(run(dir, ["log", "-n", "${MAX_COMMITS}", "--format=%H%x1f%an%x1f%at%x1f%s"])).map((l) => {
      const [sha, author, at, subject] = l.split("\x1f")
      return { sha, author: (author || "").slice(0, 120), at: Number(at) * 1000, subject: (subject || "").slice(0, 300) }
    }),
    changes: lines(run(dir, ["status", "--porcelain=v1", "-uall"])).slice(0, ${MAX_CHANGED}).map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3).slice(0, 1024) })),
    diffStat: run(dir, ["diff", "HEAD", "--shortstat"]).slice(0, 200) || null,
    fileCount: tree.length,
    files: tree.slice(0, ${MAX_TREE}).map((f) => f.slice(0, 1024))
  }
})
// The provider caps command output (256 KiB): keep the answer well under it. The main checkout keeps
// its file tree first; trees are trimmed, then dropped, until the JSON fits.
const kept = checkouts.filter((c) => c.head || c.branch)
const fits = () => Buffer.byteLength(JSON.stringify({ checkouts: kept })) <= ${MAX_OUTPUT_BYTES}
for (let i = kept.length - 1; i >= 0 && !fits(); i--) { kept[i].files = i === 0 ? kept[i].files.slice(0, 500) : [] }
for (let i = kept.length - 1; i >= 0 && !fits(); i--) { kept[i].files = []; kept[i].changes = kept[i].changes.slice(0, 50) }
while (kept.length > 1 && !fits()) kept.pop()
process.stdout.write(JSON.stringify({ checkouts: kept }) + "\n")
'
`.replaceAll('\\${', '${')

const Commit = z.object({ sha: z.string().max(64), author: z.string().max(120), at: z.number(), subject: z.string().max(300) })
const Checkout = z.object({
  path: z.string().max(4096),
  branch: z.string().max(255).nullable(),
  head: z.string().max(64).nullable(),
  upstream: z.string().max(255).nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  commits: z.array(Commit).max(MAX_COMMITS),
  changes: z.array(z.object({ status: z.string().max(2), path: z.string().max(1024) })).max(MAX_CHANGED),
  diffStat: z.string().max(200).nullable(),
  fileCount: z.number().int().min(0),
  files: z.array(z.string().max(1024)).max(MAX_TREE)
})
const PullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string().max(300),
  state: z.enum(['open', 'closed', 'merged', 'draft']),
  url: z.url({ protocol: /^https$/ }).max(2048),
  branch: z.string().max(255).optional()
})

export const ArchiveMetadataSchema = z.object({
  checkouts: z.array(Checkout).max(20),
  pullRequests: z.array(PullRequest).max(50).optional()
})
export type ArchiveMetadata = z.infer<typeof ArchiveMetadataSchema>

/** What the desktop may send at archive: PRs it knows, and git state from its cache if the VM is asleep. */
export const ArchiveRequestSchema = z
  .object({
    pullRequests: z.array(PullRequest).max(50).optional(),
    checkouts: z.array(Checkout).max(20).optional()
  })
  .strict()

async function runJson<T>(
  provider: SandboxProviderApi,
  sessionId: string,
  script: string,
  schema: z.ZodType<T>,
  timeoutMs: number
): Promise<T | null> {
  try {
    const result = await provider.runCommand(sessionId, { command: 'bash', args: ['-c', script], timeoutMs })
    if (result.exitCode !== 0) {
      return null
    }
    const parsed = schema.safeParse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''))
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (error instanceof ProviderError || error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

/** Null when the VM did not answer in time (the status panel shows "Unresponsive"). */
export function readVmMetrics(provider: SandboxProviderApi, sessionId: string): Promise<VmMetrics | null> {
  return runJson(provider, sessionId, METRICS_SCRIPT, VmMetricsSchema, 8_000)
}

export function captureArchiveMetadata(provider: SandboxProviderApi, sessionId: string): Promise<ArchiveMetadata | null> {
  return runJson(provider, sessionId, ARCHIVE_SCRIPT, ArchiveMetadataSchema, 30_000)
}
