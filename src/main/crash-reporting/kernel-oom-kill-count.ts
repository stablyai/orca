import { readFileSync } from 'node:fs'

// ─── Kernel OOM-kill counter (Linux) ────────────────────────────────
// Why: a `killed`/SIGKILL renderer looks identical whether the kernel OOM
// killer (global or a memory-cgroup limit) or some other process sent the
// signal, and host MemAvailable cannot tell a cgroup-limited kill apart. The
// `oom_kill` line in /proc/vmstat counts every kernel OOM kill on the host, so
// a delta across the death names the kernel or rules it out.

type ProcVmstatReader = () => string

const readProcVmstat: ProcVmstatReader = () => readFileSync('/proc/vmstat', 'utf8')

let procVmstatReader: ProcVmstatReader = readProcVmstat

export function setProcVmstatReaderForTest(reader: ProcVmstatReader | null): void {
  procVmstatReader = reader ?? readProcVmstat
}

export function readKernelOomKillCount(
  platform: NodeJS.Platform = process.platform
): number | undefined {
  if (platform !== 'linux') {
    return undefined
  }
  try {
    const match = /^oom_kill (\d+)$/m.exec(procVmstatReader())
    return match ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}
