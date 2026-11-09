import type { HandlerContext } from '../../dispatch'
import { RuntimeClient, RuntimeClientError } from '../../runtime-client'
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/agent-session-caller-env'
import type { OrchestrationCallerShowResult } from '../../../shared/orchestration/orchestration-caller-status'
import { renderOrchestrationArgv } from './agent-view'

type AgentServerRoutedCommand = 'send' | 'worker-start' | 'check'

const SERVER_FLAGS = new Set(['--environment', '--server'])

/** The server a remote client was pointed at, as the caller spelled it. */
function serverSelector(flags: HandlerContext['flags']): string | undefined {
  const explicit = flags.get('environment') ?? flags.get('server')
  return typeof explicit === 'string' ? explicit : process.env.ORCA_ENVIRONMENT?.trim() || undefined
}

/** Only an agent its own Orca verifies counts; a person's shell keeps --server = run it there. */
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

/** The same command with the server moved from --server to --on. */
function withOn(rawArgs: readonly string[] | undefined, server: string): string {
  const args = rawArgs ?? []
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const [name] = arg.split('=', 1)
    if (SERVER_FLAGS.has(name!)) {
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
  if (command === 'check') {
    throw new RuntimeClientError(
      'mailbox_is_local',
      `Your mailbox is on this Orca; replies from ${server} arrive here. Drop --server.`
    )
  }
  const verb = command === 'send' ? 'message an agent' : 'start a worker'
  throw new RuntimeClientError(
    'agent_server_route_refused',
    `${command} --server ${server} runs on ${server} and nothing comes back to you. To ${verb} on ${server}, use: ${withOn(ctx.rawArgs, server)}`
  )
}
