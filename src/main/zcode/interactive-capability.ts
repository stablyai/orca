import { runProcess } from '@orca/process-host'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import {
  isZCodeMissingTuiOutput,
  type ZCodeInteractiveCapability
} from '../../shared/agent-launch/installation/zcode-missing-tui'
import { structuredAgentCommandPlan } from '../../shared/agent-launch/startup/tui-agent-launch-command-override'
import {
  resolveExecutableCommandAsync,
  withCliRuntimeOnPathAsync
} from '../../shared/shell/command-resolution/node-cli-command-async-resolution'
import {
  isSpawnableCommand,
  type ResolveCommandOptions
} from '../../shared/shell/command-resolution/node-cli-command-resolution'

/** Probe before opening a pane to avoid racing fast startup failure. version/doctor never load TUI; no-TTY launch distinguishes missing @zcode/tui from loaded UI rejecting a terminal. npm resolves the package, SEA embeds assets, bundled desktop lacks both. */
export type { ZCodeInteractiveCapability }

// Measured answers arrive under a second; timeouts mean unknown, never proven missing TUI.
const PROBE_TIMEOUT_MS = 6_000

const cached = new Map<string, ZCodeInteractiveCapability>()
const inFlight = new Map<string, Promise<ZCodeInteractiveCapability>>()

type ZCodeCommand = { program: string; prefixArgs: string[] }

function isDirectZCodeExecutable(program: string, platform: NodeJS.Platform): boolean {
  const name = program.split(/[\\/]/).pop() ?? ''
  return platform === 'win32' ? /^zcode(?:\.(?:exe|cmd|bat|ps1))?$/i.test(name) : name === 'zcode'
}

/** Resolve a bare zcode executable to probe; skip user launch wrappers and custom flags so advisory probes never execute them. */
async function resolveZCodeCommand(
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined,
  options: ResolveCommandOptions
): Promise<ZCodeCommand | null> {
  const platform = options.platform ?? process.platform
  const override = settings?.agentCmdOverrides?.zcode?.trim()
  const plan = override
    ? structuredAgentCommandPlan(override, platform)
    : { program: 'zcode', prefixArgs: [] }
  if (
    !plan ||
    plan.prefixArgs.length > 0 ||
    (override && !isDirectZCodeExecutable(plan.program, platform))
  ) {
    return null
  }
  const program = await resolveExecutableCommandAsync(plan.program, options)
  return program && isSpawnableCommand(platform, program) ? { program, prefixArgs: [] } : null
}

async function probe({ program, prefixArgs }: ZCodeCommand): Promise<ZCodeInteractiveCapability> {
  try {
    const result = await runProcess({
      program,
      args: prefixArgs,
      // A CLI found in a version-manager dir needs its sibling node, as chats give it.
      env: await withCliRuntimeOnPathAsync(program, process.env),
      // Pipe explicit EOF so capable builds reject missing TTY instead of taking the probe interactive.
      input: '',
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (result.timedOut) {
      return 'unknown'
    }
    return isZCodeMissingTuiOutput(`${result.stderr}\n${result.stdout}`)
      ? 'missing-tui'
      : 'interactive'
  } catch {
    // Spawn failure proves no capability; preserve unknown rather than accuse a healthy CLI.
    return 'unknown'
  }
}

/** Cache definitive capability per resolved command; transient unknown verdicts may retry. */
export async function readZCodeInteractiveCapability(
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined,
  options: ResolveCommandOptions = {}
): Promise<ZCodeInteractiveCapability> {
  const command = await resolveZCodeCommand(settings, options)
  if (!command) {
    return 'unknown'
  }
  const key = [command.program, ...command.prefixArgs].join('\0')
  const verdict = cached.get(key)
  if (verdict !== undefined) {
    return verdict
  }
  let pending = inFlight.get(key)
  if (!pending) {
    pending = probe(command).then((result) => {
      // Retry transient unknowns so temporary load cannot suppress the missing-TUI notice for the whole session.
      if (result !== 'unknown') {
        cached.set(key, result)
      }
      inFlight.delete(key)
      return result
    })
    inFlight.set(key, pending)
  }
  return pending
}
