/**
 * On Linux each terminal runs in its own transient systemd scope, so a kernel OOM kill, a
 * systemd-oomd kill or a fork limit lands on that terminal alone, as on macOS and Windows. In the
 * daemon's own scope, systemd stops the whole scope on any OOM kill, oomd kills the whole leaf
 * cgroup, and every terminal shares one TasksMax.
 *
 * The scopes sit under one slice beside the daemon's scope, never inside it: systemd counts OOM
 * kills in a scope's descendants too, and `pids.max` counts threads, so the daemon must keep
 * serving while a terminal is at its limit. The slice is bound to the daemon's scope, so systemd
 * stops it with that scope for any reason, including ones that kill the death watch.
 *
 * `ORCA_TERMINAL_PROCESS_CEILING` sets TasksMax on each terminal's scope (Linux) or job
 * (Windows); it stays off by default. Opt-in memory limits: see terminal-memory-limits.ts.
 */
import { accessSync, constants, existsSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { userManagerEnv } from './daemon-cgroup-scope'
import {
  enforcedTerminalMemoryLimits,
  requestedTerminalMemoryLimits,
  TERMINAL_MEMORY_LIMIT_FILES,
  terminalMemoryLimitsReport,
  type TerminalMemoryLimitsReport
} from './terminal-memory-limits'
import type {
  PtyProcessCeilingOffReason,
  PtyProcessCeilingState
} from '../../shared/pty-process-ceiling-state'

export type { PtyProcessCeilingState } from '../../shared/pty-process-ceiling-state'

export const PTY_PROCESS_CEILING_ENV = 'ORCA_TERMINAL_PROCESS_CEILING'
/** Below this a shell, its prompt hooks and one build step already collide. */
const MIN_CEILING = 64
const CGROUP_ROOT = '/sys/fs/cgroup'
/** Prints the probe scope's cgroup, then `file=value` for each limit file its controllers expose. */
const PROBE_SCRIPT =
  'read -r line < /proc/self/cgroup; echo "$line"; d="/sys/fs/cgroup${line#0::}"; ' +
  `for f in pids.max ${TERMINAL_MEMORY_LIMIT_FILES.join(' ')}; do ` +
  '[ -r "$d/$f" ] && printf "%s=%s\\n" "$f" "$(cat "$d/$f")"; done; :'

type Runner = (
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => { code: number | null; timedOut: boolean; stdout: string }

// Why 1.5 s: at most four calls run before the daemon is ready, inside the launcher's 10 s wait;
// a timed-out call turns terminal scopes off and the daemon serves with terminals in its scope.
const defaultRunner: Runner = (program, args, env) =>
  runProcessSync({ program, args, env, timeoutMs: 1_500 })

/** What the Linux wrap needs at spawn time; never reported, only used. */
export type TerminalScopeRuntime = {
  slice: string
  sliceCgroupPath: string
  systemdRun: string
  envBinary: string
  /** The daemon scope's name, sanitized; shared by the slice and every scope name. */
  launchId: string
  /** `--property=` values every terminal scope gets; each one was accepted by the probe. */
  properties: string[]
}

export type TerminalScopeResolution = {
  ceiling: PtyProcessCeilingState
  /** Off says why terminals share the daemon's cgroup, for the daemon log. */
  /** `timedOut` is log-only: a busy user manager, not one that refused. */
  scopes: { on: TerminalScopeRuntime } | { off: PtyProcessCeilingOffReason; timedOut?: true }
  /** Present only when a memory limit was requested; log-only. */
  memory?: TerminalMemoryLimitsReport
}

export function parsePtyProcessCeiling(
  raw: string | undefined
): { kind: 'off' } | { kind: 'limit'; limit: number } | { kind: 'invalid' } {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '0') {
    return { kind: 'off' }
  }
  const limit = Number(raw.trim())
  return Number.isSafeInteger(limit) && limit >= MIN_CEILING
    ? { kind: 'limit', limit }
    : { kind: 'invalid' }
}

const sanitizeId = (id: string): string => id.replace(/[^A-Za-z0-9]/g, '_')

/** No dashes: systemd reads `a-b.slice` as a child of `a.slice`, and this one must be top-level. */
export function terminalSliceName(launchId: string): string {
  return `orca_ptys_${launchId}.slice`
}

function findExecutableOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter).filter(isAbsolute)) {
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {
      // Not here.
    }
  }
  return null
}

type ResolveInput = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** From `ownFreshDaemonScope`: the daemon's own scope, only when its launcher created it. */
  daemonScope: string | null
  run?: Runner
  findExecutable?: (name: string) => string | null
  unifiedCgroup?: () => boolean
  setWindowsLimit?: (limit: number) => boolean
}

/**
 * Decides once, at daemon start. Terminal scopes are on only after a probe scope started in the
 * slice with every property terminals will get; the ceiling is on only when that probe saw the
 * kernel enforce it.
 */
export function resolveTerminalScopes(input: ResolveInput): TerminalScopeResolution {
  const parsed = parsePtyProcessCeiling(input.env[PTY_PROCESS_CEILING_ENV])
  const limit = parsed.kind === 'limit' ? parsed.limit : null
  const memoryRequest = requestedTerminalMemoryLimits(input.env)
  const memoryRequested = memoryRequest.properties.length + memoryRequest.invalid.length > 0
  const withMemory = (
    resolution: TerminalScopeResolution,
    applied: string[] = []
  ): TerminalScopeResolution =>
    memoryRequested
      ? { ...resolution, memory: terminalMemoryLimitsReport(memoryRequest, applied) }
      : resolution
  const ceilingOff = (reason: PtyProcessCeilingOffReason): PtyProcessCeilingState => ({
    state: 'off',
    reason:
      parsed.kind === 'off' ? 'disabled' : parsed.kind === 'invalid' ? 'invalid_limit' : reason
  })
  const off = (reason: PtyProcessCeilingOffReason, timedOut = false): TerminalScopeResolution =>
    withMemory({
      ceiling: ceilingOff(reason),
      scopes: timedOut ? { off: reason, timedOut } : { off: reason }
    })
  if (input.platform === 'win32') {
    // Memory limits are Linux-only; Windows jobs could hold one but nothing sets it yet.
    return withMemory({
      ceiling:
        limit !== null && input.setWindowsLimit?.(limit)
          ? { state: 'on', limit, mechanism: 'windows-job', unit: null }
          : ceilingOff('native_unavailable'),
      scopes: { off: 'unsupported_platform' }
    })
  }
  if (input.platform !== 'linux') {
    return off('unsupported_platform')
  }
  // Why the daemon's own fresh scope: the slice binds to it, and a migrated legacy scope may
  // also hold the GUI. Why unified cgroups: OOMPolicy, oomd and the probe's pids.max need v2.
  const unifiedCgroup =
    input.unifiedCgroup ?? (() => existsSync(join(CGROUP_ROOT, 'cgroup.controllers')))
  if (!input.daemonScope || !unifiedCgroup()) {
    return off('no_user_manager')
  }
  const find =
    input.findExecutable ?? ((name: string) => findExecutableOnPath(name, input.env.PATH))
  const systemdRun = find('systemd-run')
  // Why env is required: without it the shell would inherit the manager's bus address, not its own.
  const envBinary = find('env')
  if (!systemdRun || !envBinary) {
    // One reason for either wrapper keeps the reported enum closed for older readers.
    return off('systemd_run_missing')
  }
  const run = input.run ?? defaultRunner
  const managerEnv = userManagerEnv(input.env)
  const launchId = sanitizeId(basename(input.daemonScope, '.scope'))
  const slice = terminalSliceName(launchId)
  try {
    const created = run(
      'busctl',
      [
        '--user',
        'call',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'StartTransientUnit',
        'ssa(sv)a(sa(sv))',
        slice,
        'fail',
        '2',
        'BindsTo',
        'as',
        '1',
        input.daemonScope,
        'After',
        'as',
        '1',
        input.daemonScope,
        '0'
      ],
      managerEnv
    )
    if (created.code !== 0 || created.timedOut) {
      return off('slice_unavailable', created.timedOut)
    }
    let probeTimedOut = false
    // Why probe, not parse a version: some systemd releases reject OOMPolicy on scopes, and an
    // unknown property fails the whole start, which would fail every terminal.
    const base = ['TimeoutStopSec=5s', ...(limit !== null ? [`TasksMax=${limit}`] : [])]
    const tiers = [['OOMPolicy=continue', ...base], base]
    // Why the memory-less tiers: a rejected memory property must not turn terminal scopes off.
    const candidates =
      memoryRequest.properties.length > 0
        ? [...tiers.map((tier) => [...tier, ...memoryRequest.properties]), ...tiers]
        : tiers
    for (const properties of candidates) {
      const probe = run(
        systemdRun,
        [
          '--user',
          '--scope',
          '--quiet',
          '--collect',
          `--slice=${slice}`,
          ...properties.map((property) => `--property=${property}`),
          '--',
          '/bin/sh',
          '-c',
          PROBE_SCRIPT
        ],
        managerEnv
      )
      const [cgroupLine, ...limitLines] = probe.stdout.trim().split('\n')
      if (probe.code !== 0 || probe.timedOut || !cgroupLine?.startsWith('0::/')) {
        probeTimedOut ||= probe.timedOut
        // Why stop: a manager that timed out once will not answer the next tier inside the
        // launcher's wait either.
        if (probe.timedOut) {
          break
        }
        continue
      }
      const cgroupValues = Object.fromEntries(
        limitLines.map((line) => {
          const at = line.indexOf('=')
          return [line.slice(0, at), line.slice(at + 1).trim()]
        })
      )
      const sliceControlGroup = dirname(cgroupLine.slice('0::'.length))
      // Why verify: managers without pids delegation accept TasksMax and enforce nothing.
      const enforced = limit !== null && cgroupValues['pids.max'] === String(limit)
      const memoryApplied = enforcedTerminalMemoryLimits(properties, cgroupValues)
      return withMemory(
        {
          ceiling: enforced
            ? {
                state: 'on',
                limit,
                mechanism: 'systemd-slice',
                unit: slice,
                controlGroup: sliceControlGroup
              }
            : ceilingOff('controller_unavailable'),
          scopes: {
            on: {
              slice,
              sliceCgroupPath: join(CGROUP_ROOT, sliceControlGroup),
              systemdRun,
              envBinary,
              launchId,
              properties: properties.filter((property) =>
                property.startsWith('TasksMax=')
                  ? enforced
                  : !memoryRequest.properties.includes(property) || memoryApplied.includes(property)
              )
            }
          }
        },
        memoryApplied
      )
    }
    run('systemctl', ['--user', '--no-block', 'stop', slice], managerEnv)
    return off('slice_unavailable', probeTimedOut)
  } catch {
    return off('slice_unavailable')
  }
}
