import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { getOptionalServePort } from '../runtime/serve-port-flag'
import { formatServeServiceInstall, formatServeServiceStatus } from './serve-service-format'
import { resolveLaunchUserDataPath } from '../runtime/launch-user-data-path'
import { getPlatformUserDataPath } from '../runtime/metadata'
import {
  clearServeSupervisorBrake,
  readServeSupervisorBrake
} from '../runtime/serve-supervisor-brake'
import {
  renderServeService,
  resolveServeServiceManager,
  type ServeServiceSpec
} from '../runtime/serve-service-unit'
import { resolveServiceCommand } from '../runtime/serve-app-launcher'

type Run = (program: string, args: string[]) => Promise<{ code: number | null; out: string }>

export type ServeServiceDeps = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homeDir: string
  uid: number
  run: Run
}

const defaultRun: Run = async (program, args) => {
  try {
    const result = await runProcess({ program, args, timeoutMs: 20_000 })
    return { code: result.timedOut ? null : result.code, out: `${result.stdout}${result.stderr}` }
  } catch (error) {
    return { code: null, out: error instanceof Error ? error.message : String(error) }
  }
}

function defaultDeps(): ServeServiceDeps {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    uid: process.getuid?.() ?? 0,
    run: defaultRun
  }
}

function requireManager(platform: NodeJS.Platform): void {
  if (!resolveServeServiceManager(platform)) {
    throw new RuntimeClientError(
      'unsupported_platform',
      '`orca serve service` is not available on Windows yet. Run `orca serve` under a service wrapper of your own.'
    )
  }
}

function serviceSpec(
  deps: ServeServiceDeps,
  options: { command: string; port?: string | null; pairingAddress?: string | null }
): ServeServiceSpec {
  return renderServeService({
    platform: deps.platform,
    homeDir: deps.homeDir,
    command: options.command,
    userDataPath: resolveLaunchUserDataPath(deps.env),
    defaultUserDataPath: getPlatformUserDataPath(deps.platform, deps.homeDir),
    path: deps.env.PATH ?? '/usr/bin:/bin',
    port: options.port,
    pairingAddress: options.pairingAddress
  })
}

async function lingerState(deps: ServeServiceDeps): Promise<'yes' | 'no' | 'unknown'> {
  const result = await deps.run('loginctl', [
    'show-user',
    String(deps.uid),
    '--property=Linger',
    '--value'
  ])
  const value = result.out.trim()
  return result.code === 0 && (value === 'yes' || value === 'no') ? value : 'unknown'
}

async function mustRun(deps: ServeServiceDeps, program: string, args: string[]): Promise<void> {
  const result = await deps.run(program, args)
  if (result.code !== 0) {
    throw new RuntimeClientError(
      'service_manager_failed',
      `\`${[program, ...args].join(' ')}\` failed: ${result.out.trim() || `exit ${String(result.code)}`}`
    )
  }
}

export async function installServeService(
  options: {
    command: string | null
    port?: string | null
    pairingAddress?: string | null
    dryRun: boolean
  },
  deps: ServeServiceDeps = defaultDeps()
): Promise<Record<string, unknown>> {
  requireManager(deps.platform)
  const spec = serviceSpec(deps, {
    ...options,
    command: resolveServiceCommand(options.command, deps)
  })
  if (options.dryRun) {
    return { installed: false, dryRun: true, ...spec }
  }
  mkdirSync(dirname(spec.unitPath), { recursive: true })
  writeFileSync(spec.unitPath, spec.content, { mode: 0o644 })
  if (spec.logPath) {
    mkdirSync(dirname(spec.logPath), { recursive: true, mode: 0o700 })
  }
  // Why: installing is the documented way to retry after the crash-loop brake gave up.
  clearServeSupervisorBrake(resolveLaunchUserDataPath(deps.env))
  if (spec.manager === 'launchd') {
    await deps.run('launchctl', ['bootout', `gui/${deps.uid}/${spec.name}`])
    await mustRun(deps, 'launchctl', ['bootstrap', `gui/${deps.uid}`, spec.unitPath])
    return {
      installed: true,
      manager: spec.manager,
      name: spec.name,
      unitPath: spec.unitPath,
      logPath: spec.logPath
    }
  }
  await mustRun(deps, 'systemctl', ['--user', 'daemon-reload'])
  await mustRun(deps, 'systemctl', ['--user', 'enable', spec.name])
  await mustRun(deps, 'systemctl', ['--user', 'restart', spec.name])
  return {
    installed: true,
    manager: spec.manager,
    name: spec.name,
    unitPath: spec.unitPath,
    linger: await lingerState(deps)
  }
}

export type ServeServiceStatus = {
  installed: boolean
  manager: ServeServiceSpec['manager']
  name: string
  unitPath: string
  /** Execution-boundary verdict for the supervisor: never guessed when the manager cannot answer. */
  verdict: 'live' | 'exited' | 'unverifiable'
  pid: number | null
  detail: string
  gaveUp: string | null
}

export async function readServeServiceStatus(
  deps: ServeServiceDeps = defaultDeps()
): Promise<ServeServiceStatus> {
  requireManager(deps.platform)
  const spec = serviceSpec(deps, { command: 'orca' })
  const base = {
    installed: existsSync(spec.unitPath),
    manager: spec.manager,
    name: spec.name,
    unitPath: spec.unitPath,
    gaveUp: readServeSupervisorBrake(resolveLaunchUserDataPath(deps.env))?.gaveUp?.reason ?? null
  }
  if (spec.manager === 'launchd') {
    const result = await deps.run('launchctl', ['print', `gui/${deps.uid}/${spec.name}`])
    if (result.code === null) {
      return { ...base, verdict: 'unverifiable', pid: null, detail: 'launchctl did not answer' }
    }
    // Why only 113: other failures (no GUI session over SSH, a refused request) prove nothing.
    if (result.code === 113) {
      return { ...base, verdict: 'exited', pid: null, detail: 'not loaded' }
    }
    if (result.code !== 0) {
      return {
        ...base,
        verdict: 'unverifiable',
        pid: null,
        detail: result.out.trim() || 'launchctl failed'
      }
    }
    const pid = Number(/^\s*pid = (\d+)/m.exec(result.out)?.[1] ?? 0) || null
    const state = /^\s*state = (\S+)/m.exec(result.out)?.[1] ?? 'unknown'
    return { ...base, verdict: pid ? 'live' : 'exited', pid, detail: state }
  }
  const result = await deps.run('systemctl', [
    '--user',
    'show',
    spec.name,
    '--property=ActiveState,SubState,MainPID'
  ])
  if (result.code !== 0) {
    return {
      ...base,
      verdict: 'unverifiable',
      pid: null,
      detail: 'systemctl --user did not answer'
    }
  }
  const field = (key: string): string =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(result.out)?.[1] ?? ''
  const pid = Number(field('MainPID')) || null
  const active = field('ActiveState')
  return {
    ...base,
    verdict: active === 'active' && pid ? 'live' : 'exited',
    pid,
    detail: `${active || 'unknown'} (${field('SubState') || 'unknown'})`
  }
}

export async function uninstallServeService(
  deps: ServeServiceDeps = defaultDeps()
): Promise<Record<string, unknown>> {
  requireManager(deps.platform)
  const spec = serviceSpec(deps, { command: 'orca' })
  await (spec.manager === 'launchd'
    ? deps.run('launchctl', ['bootout', `gui/${deps.uid}/${spec.name}`])
    : deps.run('systemctl', ['--user', 'disable', '--now', spec.name]))
  const existed = existsSync(spec.unitPath)
  rmSync(spec.unitPath, { force: true })
  if (spec.manager === 'systemd') {
    await deps.run('systemctl', ['--user', 'daemon-reload'])
  }
  return { removed: existed, manager: spec.manager, name: spec.name, unitPath: spec.unitPath }
}

/** Local, runtime-free output: the same envelope shape `--json` callers get elsewhere. */
function emit<T>(result: T, json: boolean, format: (value: T) => string): void {
  console.log(json ? JSON.stringify({ ok: true, result }, null, 2) : format(result))
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export const SERVE_SERVICE_HANDLERS: Record<string, CommandHandler> = {
  'serve service install': async ({ flags, json }) => {
    const result = await installServeService({
      command: optionalString(flags.get('command')),
      // Why validate here: a bad value fails before the supervisor's brake and launchd would loop.
      port: getOptionalServePort(flags),
      pairingAddress: optionalString(flags.get('pairing-address')),
      dryRun: flags.get('dry-run') === true
    })
    emit(result, json, formatServeServiceInstall)
  },
  'serve service status': async ({ json }) => {
    const result = await readServeServiceStatus()
    emit(result, json, formatServeServiceStatus)
  },
  'serve service uninstall': async ({ json }) => {
    const result = await uninstallServeService()
    emit(result, json, (value) =>
      value.removed ? `Removed ${String(value.name)}.` : `${String(value.name)} was not installed.`
    )
  }
}
