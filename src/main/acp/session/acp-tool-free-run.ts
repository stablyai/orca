// A tool-free ACP run (see `toolFreeSession`): ACP has no way to turn an agent's tools off, so the
// run starts in an empty folder, asks for every tool, has every request refused, and is stopped at
// its first tool call.
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { AcpRpcError } from '../transport/acp-errors'
import { acpRunFolder } from '../launch/acp-private-temp'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AcpStructuredLaunch } from '../launch/acp-structured-launch-resolution'
import type { AcpSessionRuntimeOptions } from '../protocol/acp-session-runtime-options'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import { acpStructuredPermissionHandler } from '../requests/acp-structured-permission-handler'
import type { AcpStructuredPrompts } from '../requests/acp-structured-prompts'
import { denyAcpTextTaskPermission } from '../text-task/acp-text-task-policy'
import type { AcpStructuredChild } from './children/acp-structured-child'
import { acpAgentName } from './acp-structured-agent-definitions'
import type { StructuredAgentLaunchPartResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import type { AgentChatPermissionChoice } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'

type ToolFreeLaunch = { spec: AcpLaunchSpec; toolFree?: { cwd: string } }
type RunRequests = Required<Pick<AcpSessionRuntimeOptions, 'onPermission' | 'onRequest'>>

/** The agent started tool work: a tool call, or an update to one. */
export function isAcpToolWork(update: { sessionUpdate: string }): boolean {
  return update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
}

/** A tool-free launch resolves in an empty folder of its own, so files the agent's instructions
 *  are written to never land in the session's own folder; the launch's release removes it. */
export function withAcpToolFreeFolder(
  deps: { dataDirectory: string; logger?: StructuredAgentSessionLogger },
  part: StructuredAgentLaunchPartResolver<AcpStructuredLaunch>
): StructuredAgentLaunchPartResolver<AcpStructuredLaunch> {
  return async (basis, identity) => {
    if (!basis.toolFree) {
      return part(basis, identity)
    }
    const folder = await acpRunFolder(join(deps.dataDirectory, 'acp-tool-free'), deps.logger)
    try {
      // Agents compare the session folder with their own resolved cwd (macOS /var is /private/var).
      const cwd = await realpath(folder.path)
      const composed = await part({ ...basis, launchDirectory: async () => cwd }, identity)
      const { release } = composed.launch
      const releaseAll = async (): Promise<void> => {
        try {
          await release?.()
        } finally {
          await folder.remove()
        }
      }
      return { ...composed, launch: { ...composed.launch, toolFree: { cwd }, release: releaseAll } }
    } catch (error) {
      await folder.remove()
      throw error
    }
  }
}

/** A tool-free run starts in its folder and asks, whatever the chat chose, so a mode an agent
 *  enforces itself never approves for it. Any other launch is unchanged. */
export function acpToolFreeRun<
  L extends ToolFreeLaunch & { cwd: string },
  A extends { permissionMode?: AgentChatPermissionChoice }
>(launch: L, acquire: A): { launch: L; acquire: A } {
  return launch.toolFree
    ? {
        launch: { ...launch, cwd: launch.toolFree.cwd },
        acquire: { ...acquire, permissionMode: 'ask' }
      }
    : { launch, acquire }
}

/** A tool-free run turns every permission request down and refuses every other request, since
 *  nobody is there to answer; a chat answers through its prompts. */
export function acpRunRequests(
  launch: ToolFreeLaunch,
  session: () => AcpStructuredChild | null,
  prompts: AcpStructuredPrompts
): RunRequests {
  return launch.toolFree
    ? {
        onPermission: (request) => denyAcpTextTaskPermission(request),
        onRequest: (method) => {
          throw new AcpRpcError(-32601, `${method} is unavailable in a run without tools`)
        }
      }
    : {
        onPermission: acpStructuredPermissionHandler(session, launch.spec, prompts),
        onRequest: (method, params, context) => prompts.handle(method, params, context)
      }
}

/** Stops a tool-free run at its first tool call. */
export function stopAtToolWork(
  launch: ToolFreeLaunch,
  connection: Pick<AcpStructuredConnection, 'subscribe'>,
  stop: (reason: string) => void
): void {
  if (!launch.toolFree) {
    return
  }
  const reason = `Orca stopped ${acpAgentName(launch.spec.agent)}: it tried to use a tool in a run that needs none`
  connection.subscribe((event) => {
    if (isAcpToolWork(event.kind === 'known' ? event.notification.update : event.raw.update)) {
      stop(reason)
    }
  })
}
