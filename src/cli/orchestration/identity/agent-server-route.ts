import type { HandlerContext } from '../../dispatch/dispatch'
import { RuntimeClient } from '../../runtime/client'
import { RuntimeClientError } from '../../runtime/connection/types'
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { OrchestrationCallerShowResult } from '../../../shared/orchestration/orchestration-caller-status'
import { renderOrchestrationArgv } from '../agent-view'
import type { RuntimeStatus } from '../../../shared/runtime-session-contracts'
import { ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'

type AgentServerRoutedCommand = 'send' | 'worker-start' | 'check'

/** The server a remote client was pointed at, as the caller spelled it. */
function serverSelector(
  flags: HandlerContext['flags']
): { name: string; route: string } | undefined {
  const explicit = flags.get('environment')
  if (typeof explicit === 'string') {
    return { name: explicit, route: `--environment ${explicit}` }
  }
  const inherited = process.env.ORCA_ENVIRONMENT?.trim()
  return inherited ? { name: inherited, route: `ORCA_ENVIRONMENT=${inherited}` } : undefined
}

/** Only an agent its own Orca verifies counts; a person's shell keeps --environment = run it there. */
async function isOrcaVerifiedAgent(): Promise<boolean> {
  if (!readInjectedAgentSessionId() && !process.env.ORCA_AGENT_LAUNCH_TOKEN?.trim()) {
    return false
  }
  try {
    const local = new RuntimeClient(undefined, 10_000, null, null)
    const { result } = await local.call<OrchestrationCallerShowResult>('orchestration.callerShow')
    return result.caller !== null || result.terminal === true
  } catch {
    return false
  }
}

/** The same command with the server moved from --environment to --on. */
function withOn(rawArgs: readonly string[] | undefined, server: string): string {
  const args = rawArgs ?? []
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const [name] = arg.split('=', 1)
    if (name === '--environment') {
      if (!arg.includes('=')) {
        index += 1
      }
      continue
    }
    kept.push(arg)
  }
  const at = kept.findIndex((arg) => arg === 'send' || arg === 'worker-start')
  kept.splice(at + 1, 0, '--on', server)
  return renderOrchestrationArgv(kept) ?? ''
}

/** An agent's mail and workers live on its own Orca; pointing them at another server reaches nobody. */
export async function refuseAgentServerRoute(
  command: AgentServerRoutedCommand,
  ctx: HandlerContext
): Promise<void> {
  if (!ctx.client.isRemote || ctx.flags.has('on')) {
    return
  }
  const server = serverSelector(ctx.flags)
  if (!server || !(await isOrcaVerifiedAgent())) {
    return
  }
  const { name, route } = server
  if (command === 'check') {
    throw new RuntimeClientError(
      'mailbox_is_local',
      `Your mailbox is on this Orca; replies from ${name} arrive here. Drop ${route}.`
    )
  }
  const verb = command === 'send' ? 'message an agent' : 'start a worker'
  throw new RuntimeClientError(
    'agent_server_route_refused',
    `${command} with ${route} runs on ${name} and nothing comes back to you. To ${verb} on ${name}, use: ${withOn(ctx.rawArgs, name)}`
  )
}

/** An older Orca would drop --on and send the mail to an agent here, so it must carry mail between servers first. */
export async function requirePeerMailCarrier(ctx: HandlerContext): Promise<void> {
  if (!ctx.flags.has('on')) {
    return
  }
  const { result } = await ctx.client.call<RuntimeStatus>('status.get')
  if (!result.capabilities?.includes(ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'server_mail_unsupported',
      'The Orca running here is too old to carry mail to another server. Update or restart Orca here, then send again. Nothing was sent.'
    )
  }
}
