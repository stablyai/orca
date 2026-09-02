/**
 * `orcad --print-service` and `orcad --doctor`.
 *
 * Why these live in orcad rather than only the `orca` CLI: the shipped orcad artifact is
 * three files and no CLI (`ORCAD_ARTIFACTS`), so a host that installed only the orcad
 * tarball — the deployment this exists for — has no `orca` binary to run. The CLI can
 * mirror these over the same pure functions where it happens to be installed.
 *
 * Both are handled before `runOrcadNativePreflight()` in `main.ts`, for the reason already
 * written there: proving something must not bind a port or take the data-root lock. Data
 * root resolution is pure environment reads, so the pinned value is available that early.
 */
import { userInfo } from 'node:os'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import {
  auditSupervisorServices,
  readConfiguredEndpoint,
  sortBySeverity,
  supervisorAuditPassed,
  type SupervisorFinding,
  type SupervisorServiceFile
} from '../../shared/supervisor-service-audit'
import { gatherSupervisorEvidence } from '../../shared/supervisor-service-probe'
import {
  observeDataRootIdentity,
  observeExecTarget,
  observeJournal
} from './supervisor-host-observations'
import { auditDaemonSocketPathBudget } from './supervisor-daemon-socket-budget'
import type { ProbeTarget } from '../../shared/supervisor-service-probe'
import {
  renderSupervisorService,
  resolveSupervisorPlatform,
  supervisorInstallHint,
  SupervisorServiceUnsupportedError,
  type SupervisorScope
} from '../../shared/supervisor-service-render'
import { ORCAD_ENTRY_FILENAME } from '../../shared/orcad-artifacts'
import { collectServiceFiles } from './supervisor-service-discovery'
import { resolveUserDataPath } from './orcad-app-paths'
import {
  interpreterOnDiskWarning,
  launchdLogDestinationWarning,
  resolveRealPath,
  socketPathBudgetWarning,
  userScopeUnavailableWarning,
  versionScopedInterpreterWarning
} from './supervisor-generation-warnings'

export {
  collectServiceFiles,
  inferScopeFromPath,
  type ServiceFileDiscovery,
  type UnreadableServiceFile
} from './supervisor-service-discovery'

export const PRINT_SERVICE_FLAG = '--print-service'
export const DOCTOR_FLAG = '--doctor'

const DEFAULT_PORT = 6800

type ServiceCommandOptions = {
  scope: SupervisorScope
  nodePath?: string
  user?: string
  port: number
  bind: string
  /** Audit a definition outside the conventional locations. */
  servicePath?: string
  /** Skip live probes: the file-only audit, for a host where shelling out is unwanted. */
  noProbe?: boolean
  /** Absolute path to the `orcad.js` the unit should exec; required when this is not orcad. */
  orcadPath?: string
}

/**
 * Deliberately separate from `parseArgs`: that one throws on any unknown argument and is
 * reached only from `main()`, which is past the point where a port gets bound.
 *
 * It rejects unknown arguments for the same reason `parseArgs` does. Being separate was
 * never meant to make it permissive, but it silently dropped anything it did not
 * recognise, and two flags an operator would plausibly reach for went nowhere:
 * `--user-data`, which this tool's own socket-budget remedy used to recommend, and
 * `--json`, which exists on `orca supervisor doctor` but not here — the tarball
 * deployment this command exists for has no `orca` CLI, so on those hosts the JSON form
 * is unreachable and the flag asking for it was swallowed. Erroring is what makes that
 * discoverable.
 */
export function parseServiceCommandArgs(argv: string[]): ServiceCommandOptions {
  const options: ServiceCommandOptions = { scope: 'system', port: DEFAULT_PORT, bind: '127.0.0.1' }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1]
    if (argv[i] === '--scope') {
      if (value !== 'user' && value !== 'system') {
        throw new Error(`--scope expects 'user' or 'system', got ${value ?? "''"}`)
      }
      options.scope = value
      i += 1
    } else if (argv[i] === '--node') {
      if (!value) {
        throw new Error('--node expects a path')
      }
      options.nodePath = value
      i += 1
    } else if (argv[i] === '--user') {
      if (!value) {
        throw new Error('--user expects an account name')
      }
      options.user = value
      i += 1
    } else if (argv[i] === '--orcad') {
      if (!value) {
        throw new Error('--orcad expects a path')
      }
      options.orcadPath = value
      i += 1
    } else if (argv[i] === '--service-path') {
      if (!value) {
        throw new Error('--service-path expects a path')
      }
      options.servicePath = value
      i += 1
    } else if (argv[i] === '--no-probe') {
      options.noProbe = true
    } else if (argv[i] === '--port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port expects an integer 0-65535, got ${value ?? "''"}`)
      }
      options.port = port
      i += 1
    } else if (argv[i] === '--bind') {
      if (!value) {
        throw new Error('--bind expects a value')
      }
      options.bind = value
      i += 1
    } else if (argv[i] !== PRINT_SERVICE_FLAG && argv[i] !== DOCTOR_FLAG) {
      // The mode flags are part of the argv this is handed, so they are not "unknown".
      throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return options
}

/**
 * The `orcad.js` the generated unit will exec.
 *
 * Why argv[1] and not cwd: the same reason `resolveOrcadInstallRoot` uses it — cwd is
 * wherever the operator happened to be, so a sibling resolved against it is found by luck.
 *
 * Why the basename is then checked rather than trusted: argv[1] is orcad's own entry only
 * when orcad is the process running this. Reached through `orca supervisor print` it is the
 * CLI's entry instead, and the unit came out pinning `ExecStart=<node> .../cli/index.js
 * --bind ... --port ... --json` — the orca CLI, handed orcad's flags, which exits before it
 * serves anything. The failure is silent at generation time and only surfaces as a unit that
 * will not start, so this refuses instead and names the flag that answers it.
 */
function resolveOrcadEntryPath(explicit?: string): string {
  if (explicit) {
    return resolve(explicit)
  }
  const entry = process.argv[1]
  if (!entry) {
    throw new Error('cannot resolve this orcad bundle: process.argv[1] is unset')
  }
  const resolved = resolve(entry)
  if (basename(resolved) !== ORCAD_ENTRY_FILENAME) {
    throw new Error(
      `this process is ${resolved}, not ${ORCAD_ENTRY_FILENAME}, so it cannot say which ` +
        'orcad the service should run. Pass --orcad <path to orcad.js>, or run ' +
        '`orcad --print-service` from the orcad bundle itself.'
    )
  }
  return resolved
}

export async function printService(argv: string[]): Promise<number> {
  const options = parseServiceCommandArgs(argv)
  const platform = resolveSupervisorPlatform(process.platform)
  const nodePath = options.nodePath ?? process.execPath
  const config = {
    platform,
    scope: options.scope,
    nodePath,
    orcadPath: resolveOrcadEntryPath(options.orcadPath),
    // Resolved through symlinks so `RequiresMountsFor` can reach a real mount unit:
    // systemd maps that directive textually and never sees through a symlinked ancestor.
    userDataPath: resolveRealPath(resolveUserDataPath()),
    // Generating as root is normal (sudo, a container); running orcad as root is not, so
    // the account is a flag rather than an inheritance.
    user: options.user ?? userInfo().username,
    bind: options.bind,
    port: options.port
  }
  const hint = supervisorInstallHint(config)
  process.stdout.write(renderSupervisorService(config))

  // Why before the install block and unindented: the hint is a copy-paste unit, and a
  // warning folded into it reads as part of the instructions rather than a caveat on them.
  const warnings = [
    // First because it is the only one of these that means the service cannot work at all.
    socketPathBudgetWarning(config.userDataPath),
    versionScopedInterpreterWarning(nodePath),
    interpreterOnDiskWarning(nodePath, options.nodePath !== undefined),
    ...(platform === 'launchd' ? [launchdLogDestinationWarning()] : []),
    ...(platform === 'systemd' && options.scope === 'user'
      ? [await userScopeUnavailableWarning()]
      : [])
  ].filter((warning): warning is string => warning !== null)
  if (warnings.length > 0) {
    process.stderr.write(`\n${warnings.join('\n\n')}\n`)
  }

  // Why stderr: stdout is the file, so it stays pipeable straight into the target path.
  process.stderr.write(
    `\nWrite this to: ${hint.path}\nThen run:\n${hint.commands.map((c) => `  ${c}`).join('\n')}\n`
  )
  return 0
}

const SEVERITY_LABEL = {
  critical: 'CRITICAL',
  warning: 'WARN',
  unverifiable: 'UNVERIFIED',
  ok: 'OK'
} as const

export function formatFindings(findings: SupervisorFinding[]): string {
  return findings
    .map((finding) => {
      const head = `[${SEVERITY_LABEL[finding.severity]}] ${finding.message}`
      return finding.remedy ? `${head}\n         ${finding.remedy}` : head
    })
    .join('\n')
}

/**
 * Why the discovered file's own basename and not a constant: discovery searches the
 * conventional locations AND accepts an explicit path, precisely because an operator may
 * have renamed things. Probing a constant would query a unit that does not exist and
 * report the file we did find as not running.
 */
function probeTargetFor(file: SupervisorServiceFile, options: ServiceCommandOptions): ProbeTarget {
  const name = basename(file.path, file.platform === 'launchd' ? '.plist' : '')
  // The endpoint comes from the file for the same reason the unit name does: the flags
  // describe what to generate, the file describes what is actually installed.
  const endpoint = readConfiguredEndpoint(file)
  return {
    platform: file.platform,
    scope: file.scope,
    name,
    user: options.user ?? userInfo().username,
    bind: endpoint?.bind ?? options.bind,
    port: endpoint?.port ?? options.port
  }
}

/** Shared by the text and JSON paths so neither can drift from the other's verdict. */
export async function collectDoctorFindings(
  argv: string[]
): Promise<{ findings: SupervisorFinding[]; code: number }> {
  const platform = resolveSupervisorPlatform(process.platform)
  const options = parseServiceCommandArgs(argv)
  const { files, unreadable } = collectServiceFiles(
    platform,
    options.servicePath ? [options.servicePath] : []
  )
  // Only probe one definition: with two, every result would be ambiguous about which it
  // described, and the duplicate finding is the story anyway.
  const probing = files.length === 1 && !options.noProbe
  // Why these two run even under --no-probe: they are a stat and a config read, not a
  // subprocess, and they stay useful on a host where every live probe is refused.
  const expectedUserDataPath = resolveUserDataPath()
  const onDisk =
    files.length === 1
      ? {
          execTarget: observeExecTarget(files[0]),
          journal: observeJournal(files[0]),
          dataRootSameDirectory: observeDataRootIdentity(files[0], expectedUserDataPath)
        }
      : {}
  const evidence = probing
    ? { ...(await gatherSupervisorEvidence(probeTargetFor(files[0], options))), ...onDisk }
    : files.length === 1
      ? onDisk
      : undefined
  const findings = auditSupervisorServices({
    files,
    expectedUserDataPath,
    evidence,
    unreadable
  })
  // Why unconditionally, and never gated by --no-probe: it is arithmetic on a path. Its whole
  // value is answering before an operator commits to a host, which is when nothing is running
  // to probe. `files[0]` only when it is the only one, matching the rule above.
  findings.push(
    auditDaemonSocketPathBudget(files.length === 1 ? files[0] : undefined, expectedUserDataPath)
  )
  // Why say so: a silently file-only report looks identical to one where every probe
  // happened to come back clean.
  if (!probing && files.length > 0) {
    findings.push({
      code: 'live_state_not_probed',
      severity: 'unverifiable',
      message: options.noProbe
        ? 'Live state was not checked (--no-probe).'
        : `Live state was not checked: ${files.length} service definitions found, so any result would be ambiguous about which one it described.`
    })
  }
  // Why not non-zero on unverifiable: a check that could not run is not a failed check,
  // and a doctor that exits 1 on "could not verify" trains operators to ignore it.
  return { findings: sortBySeverity(findings), code: supervisorAuditPassed(findings) ? 0 : 1 }
}

export async function runDoctor(argv: string[]): Promise<number> {
  const { findings, code } = await collectDoctorFindings(argv)
  process.stdout.write(`${formatFindings(findings)}\n`)
  return code
}

/** True when this invocation is a service command rather than a server start. */
export function isServiceCommand(argv: string[]): boolean {
  return argv.includes(PRINT_SERVICE_FLAG) || argv.includes(DOCTOR_FLAG)
}

export async function runServiceCommand(argv: string[]): Promise<number> {
  try {
    return argv.includes(PRINT_SERVICE_FLAG) ? await printService(argv) : await runDoctor(argv)
  } catch (error) {
    const unsupported = error instanceof SupervisorServiceUnsupportedError
    process.stderr.write(`orcad: ${error instanceof Error ? error.message : String(error)}\n`)
    // 78 is EX_CONFIG: an unsupported platform or a bad flag is not fixed by retrying.
    return unsupported ? 78 : 1
  }
}
