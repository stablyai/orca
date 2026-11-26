// A tool-free ACP run (see `toolFreeSession`): ACP has no way to turn an agent's tools off, so the
// run starts in an empty folder, every request it sends is refused, and its first tool call stops it.
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { AcpRpcError } from '../transport/acp-errors'
import { acpRunFolder } from '../launch/acp-private-temp'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AcpSessionRuntimeOptions } from '../protocol/acp-session-runtime-options'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import { acpStructuredPermissionHandler } from '../requests/acp-structured-permission-handler'
import type { AcpStructuredPrompts } from '../requests/acp-structured-prompts'
import { denyAcpTextTaskPermission } from '../text-task/acp-text-task-policy'
import type { AcpStructuredChild } from './children/acp-structured-child'
import { acpAgentName } from './acp-structured-agent-definitions'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'

type ToolFreeLaunch = {
  spec: AcpLaunchSpec
  toolFree?: true
  cwd: string
  release?: () => Promise<void>
}
type RunRequests = Required<Pick<AcpSessionRuntimeOptions, 'onPermission' | 'onRequest'>>
type Guard = (
  connection: Pick<AcpStructuredConnection, 'subscribe' | 'onExit'>,
  stop: (reason: string) => void
) => void

/** The agent started tool work: a tool call, or an update to one. */
export function isAcpToolWork(update: { sessionUpdate: string }): boolean {
  return update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
}

/** A tool-free run turns every permission request down and refuses every other request, since
 *  nobody is there to answer; a chat answers through its prompts. */
export function acpRunRequests(
  launch: Pick<ToolFreeLaunch, 'spec' | 'toolFree'>,
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

/** A tool-free run starts in an empty folder of its own; its guard stops the run at its first tool
 *  call and removes the folder when the process exits. Any other launch is unchanged. */
export async function acpToolFreeLaunch<L extends ToolFreeLaunch>(
  launch: L,
  deps: { dataDirectory: string; logger?: StructuredAgentSessionLogger }
): Promise<{ launch: L; guard: Guard }> {
  if (!launch.toolFree) {
    return { launch, guard: () => {} }
  }
  try {
    const folder = await acpRunFolder(join(deps.dataDirectory, 'acp-tool-free'), deps.logger)
    // Agents compare the session folder with their own resolved cwd (macOS /var is /private/var).
    const cwd = await realpath(folder.path)
    const reason = `Orca stopped ${acpAgentName(launch.spec.agent)}: it tried to use a tool in a run that needs none`
    const guard: Guard = (connection, stop) => {
      connection.onExit(() => void folder.remove())
      connection.subscribe((event) => {
        if (isAcpToolWork(event.kind === 'known' ? event.notification.update : event.raw.update)) {
          stop(reason)
        }
      })
    }
    return { launch: { ...launch, cwd }, guard }
  } catch (error) {
    void launch.release?.().catch(() => undefined)
    throw error
  }
}
