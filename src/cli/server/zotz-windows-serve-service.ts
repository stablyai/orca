import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  windowsPowerShellPath,
  windowsSystem32Binary
} from '@orca/process-host/windows-system-binary'
import { quotePowerShellLiteral } from '../../shared/shell/launch/powershell-native-argument'
import {
  ZOTZ_WINDOWS_TASK_FOLDER,
  encodeWindowsTaskXml,
  renderZotzWindowsScheduledTaskXml,
  resolveWindowsTaskUserId,
  zotzWindowsTaskPath
} from '../../shared/zotz/zotz-windows-scheduled-task'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveLaunchUserDataPath } from '../runtime/profile/launch-user-data-path'
import { getPlatformUserDataPath } from '../runtime/profile/metadata'
import { serveServiceArgs } from '../runtime/serve/supervision/serve-service-unit'
import type { ServeServiceDeps, ServeServiceStatus } from './serve-service'

const SERVE_TASK_NAME = 'Serve'
const SERVE_TASK_PATH = zotzWindowsTaskPath(SERVE_TASK_NAME)

export type WindowsServeServiceOptions = {
  command: string
  port?: string | null
  bind?: string | null
  pairingAddress?: string | null
  allowPublic?: boolean
  refusePublic?: boolean
}

type WindowsServeServiceSpec = {
  manager: 'task-scheduler'
  name: string
  unitPath: string
  logPath: null
  content: string
}

function taskXmlPath(deps: ServeServiceDeps): string {
  return join(resolveLaunchUserDataPath(deps.env), 'zotz-serve-task.xml')
}

/** Task Scheduler cannot set environment variables, so only the default profile can be served. */
function requireDefaultProfile(deps: ServeServiceDeps): void {
  const userDataPath = resolveLaunchUserDataPath(deps.env)
  if (userDataPath !== getPlatformUserDataPath(deps.platform, deps.homeDir)) {
    throw new RuntimeClientError(
      'unsupported_profile',
      `On Windows, \`serve service\` only supports the default profile; ${userDataPath} is a custom one. Run \`orca serve\` for it under your own wrapper.`
    )
  }
}

export function renderWindowsServeService(
  deps: ServeServiceDeps,
  options: WindowsServeServiceOptions
): WindowsServeServiceSpec {
  requireDefaultProfile(deps)
  // Task Scheduler is the supervisor here; `--supervise` is POSIX-only.
  const args = serveServiceArgs(options).filter((arg) => arg !== '--supervise')
  return {
    manager: 'task-scheduler',
    name: SERVE_TASK_PATH,
    unitPath: taskXmlPath(deps),
    logPath: null,
    content: renderZotzWindowsScheduledTaskXml({
      taskPath: SERVE_TASK_PATH,
      userId: resolveWindowsTaskUserId(deps.env, deps.env.USERNAME ?? 'user'),
      command: options.command,
      args,
      workingDirectory: deps.homeDir,
      description: 'Zotz headless server (orca serve), restarted when it stops.',
      // orca.exe is a console program; an interactive task would show its window at every logon.
      logonType: 'S4U'
    })
  }
}

async function mustRun(deps: ServeServiceDeps, program: string, args: string[]): Promise<void> {
  const result = await deps.run(program, args)
  if (result.code !== 0) {
    const denied = /access is denied|acceso denegado/i.test(result.out)
    throw new RuntimeClientError(
      'service_manager_failed',
      `\`schtasks ${args.join(' ')}\` failed: ${result.out.trim() || `exit ${String(result.code)}`}${denied ? ' Run it again from an elevated terminal (logon tasks need administrator rights).' : ''}`
    )
  }
}

export async function installWindowsServeService(
  deps: ServeServiceDeps,
  options: WindowsServeServiceOptions & { dryRun: boolean }
): Promise<Record<string, unknown>> {
  const spec = renderWindowsServeService(deps, options)
  if (options.dryRun) {
    return { installed: false, dryRun: true, ...spec }
  }
  mkdirSync(dirname(spec.unitPath), { recursive: true })
  writeFileSync(spec.unitPath, encodeWindowsTaskXml(spec.content))
  const schtasks = windowsSystem32Binary('schtasks.exe', deps.env)
  await mustRun(deps, schtasks, ['/Create', '/TN', spec.name, '/XML', spec.unitPath, '/F'])
  // Start now instead of waiting for the next logon; a failed start is retried by the trigger.
  await deps.run(schtasks, ['/Run', '/TN', spec.name])
  return {
    installed: true,
    manager: spec.manager,
    name: spec.name,
    unitPath: spec.unitPath,
    logPath: null
  }
}

/** ScheduledTask.State is an enum, so its name is stable across Windows display languages. */
export function windowsTaskStateScript(taskName: string): string {
  return `$task = Get-ScheduledTask -TaskPath ${quotePowerShellLiteral(ZOTZ_WINDOWS_TASK_FOLDER)} -TaskName ${quotePowerShellLiteral(taskName)} -ErrorAction SilentlyContinue
if ($null -eq $task) { 'Missing' } else { [string]$task.State }`
}

export async function readWindowsServeServiceStatus(
  deps: ServeServiceDeps
): Promise<ServeServiceStatus> {
  const unitPath = taskXmlPath(deps)
  const base = {
    manager: 'task-scheduler' as const,
    name: SERVE_TASK_PATH,
    unitPath,
    pid: null,
    gaveUp: null
  }
  const result = await deps.run(windowsPowerShellPath(deps.env), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    windowsTaskStateScript(SERVE_TASK_NAME)
  ])
  const state = result.out.trim()
  if (result.code !== 0 || !state) {
    return {
      ...base,
      installed: existsSync(unitPath),
      verdict: 'unverifiable',
      detail: state || 'Task Scheduler did not answer'
    }
  }
  if (state === 'Missing') {
    return { ...base, installed: false, verdict: 'exited', detail: 'not registered' }
  }
  return {
    ...base,
    installed: true,
    verdict: state === 'Running' ? 'live' : 'exited',
    detail: state
  }
}

export async function uninstallWindowsServeService(
  deps: ServeServiceDeps
): Promise<Record<string, unknown>> {
  const schtasks = windowsSystem32Binary('schtasks.exe', deps.env)
  await deps.run(schtasks, ['/End', '/TN', SERVE_TASK_PATH])
  const deleted = await deps.run(schtasks, ['/Delete', '/TN', SERVE_TASK_PATH, '/F'])
  const unitPath = taskXmlPath(deps)
  rmSync(unitPath, { force: true })
  return {
    removed: deleted.code === 0,
    manager: 'task-scheduler',
    name: SERVE_TASK_PATH,
    unitPath
  }
}
