import { join } from 'node:path'
import type { ZotzNodeSetupStepId } from '../../shared/zotz/zotz-node-setup-contract'
import { ZOTZ_TAILNET_RANGE } from '../../shared/zotz/zotz-node-setup-contract'
import {
  encodeWindowsTaskXml,
  resolveWindowsTaskUserId
} from '../../shared/zotz/zotz-windows-scheduled-task'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import { renderZotzDesktopAutostart, ZOTZ_SERVER_TASK_PATH } from './zotz-desktop-autostart'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import type { ZotzNodeSetupOutcome, ZotzNodeSetupPhase } from './zotz-node-setup-orchestrator'
import { runElevatedWindowsProcess } from './zotz-windows-elevation'

export const WINDOWS_ELEVATED_STEPS = [
  'power',
  'windowsUpdate',
  'ssh',
  'firewall',
  'autostart'
] as const satisfies readonly ZotzNodeSetupStepId[]

// Installing OpenSSH Server through Windows Update can take several minutes.
const ELEVATED_SCRIPT_TIMEOUT_MS = 30 * 60_000

type Outcomes = Partial<Record<ZotzNodeSetupStepId, ZotzNodeSetupOutcome>>

function allSteps(outcome: ZotzNodeSetupOutcome): Outcomes {
  return Object.fromEntries(WINDOWS_ELEVATED_STEPS.map((id) => [id, outcome]))
}

/** Reads the per-step JSON zotz-node-setup.ps1 writes to -ResultPath. */
export function parseNodeSetupScriptResult(json: string): Outcomes {
  let parsed: { steps?: unknown }
  try {
    parsed = JSON.parse(json.replace(/^\uFEFF/, '')) as typeof parsed
  } catch {
    return {}
  }
  const outcomes: Outcomes = {}
  for (const step of Array.isArray(parsed.steps) ? parsed.steps : []) {
    const { id, status, detail } = (step ?? {}) as {
      id?: unknown
      status?: unknown
      detail?: unknown
    }
    if (
      typeof id === 'string' &&
      (WINDOWS_ELEVATED_STEPS as readonly string[]).includes(id) &&
      (status === 'done' || status === 'skipped' || status === 'failed')
    ) {
      outcomes[id as ZotzNodeSetupStepId] = {
        status,
        ...(typeof detail === 'string' && detail ? { detail } : {})
      }
    }
  }
  return outcomes
}

export function nodeSetupScriptArgs(input: {
  scriptPath: string
  appPath: string
  port: number
  resultPath: string
  logPath: string
  taskXmlPath: string | null
}): string[] {
  // RemoteSigned (not Bypass) runs the locally installed script and keeps EDR signal low.
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'RemoteSigned',
    '-File',
    input.scriptPath,
    '-Port',
    String(input.port),
    '-TailnetRange',
    ZOTZ_TAILNET_RANGE,
    '-ResultPath',
    input.resultPath,
    '-LogPath',
    input.logPath,
    '-AppPath',
    input.appPath,
    ...(input.taskXmlPath
      ? ['-TaskXmlPath', input.taskXmlPath, '-TaskName', ZOTZ_SERVER_TASK_PATH]
      : [])
  ]
}

/** Everything that needs an administrator goes through one script and one UAC prompt. */
export function windowsElevatedPhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: WINDOWS_ELEVATED_STEPS,
    run: async () => {
      if (!environment.setupScriptPath) {
        return allSteps({
          status: 'failed',
          detail: 'zotz-node-setup.ps1 is missing from this build'
        })
      }
      let taskXmlPath: string | null = null
      if (environment.isPackaged) {
        const autostart = renderZotzDesktopAutostart({
          platform: 'win32',
          executablePath: environment.executablePath,
          homeDir: environment.homeDir,
          userDataPath: environment.userDataPath,
          // Read before elevating: an over-the-shoulder admin prompt runs as another account.
          windowsUserId: resolveWindowsTaskUserId(environment.env, environment.username)
        })
        if (autostart) {
          environment.writeFile(autostart.path, encodeWindowsTaskXml(autostart.content))
          taskXmlPath = autostart.path
        }
      }
      const resultPath = join(environment.userDataPath, 'zotz-node-setup-result.json')
      const logPath = join(environment.userDataPath, 'zotz-node-setup.log')
      environment.removeFile(resultPath)
      const elevation = await runElevatedWindowsProcess(
        environment.run,
        environment.env,
        windowsPowerShellPath(environment.env),
        nodeSetupScriptArgs({
          scriptPath: environment.setupScriptPath,
          appPath: environment.executablePath,
          port: environment.port,
          resultPath,
          logPath,
          taskXmlPath
        }),
        ELEVATED_SCRIPT_TIMEOUT_MS
      )
      if (!elevation.launched) {
        return allSteps({
          status: 'failed',
          detail: elevation.cancelled ? 'administrator permission was declined' : elevation.detail
        })
      }
      const outcomes = parseNodeSetupScriptResult(environment.readText(resultPath) ?? '')
      const missing: ZotzNodeSetupOutcome = {
        status: 'failed',
        detail: `the setup script exited ${String(elevation.exitCode)} without a result; see ${logPath}`
      }
      if (!taskXmlPath && !outcomes.autostart) {
        outcomes.autostart = { status: 'skipped', detail: 'development build' }
      }
      return { ...allSteps(missing), ...outcomes }
    }
  }
}
