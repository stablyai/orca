import { acpAccountHomeVariable, acpSpawnRecipe } from '../../shared/acp-agent-recipes'
import { CODEX_SPAWN_TOKEN_ENV } from '../codex/codex-structured-owner-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { AcpJsonRpcLaunch } from './acp-jsonrpc-connection'
import { AcpStructuredSessionAdapter } from './acp-structured-session-adapter'
import type { openAcpJsonRpcConnection } from './acp-jsonrpc-connection'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export function createAcpStructuredSessionAdapter(input: {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  readProcessStartTime: (pid: number) => Promise<number | null>
  openConnection?: typeof openAcpJsonRpcConnection
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
}): AcpStructuredSessionAdapter {
  return new AcpStructuredSessionAdapter({
    resolveLaunch: (launchInput) =>
      resolveAcpStructuredLaunch({
        identity: launchInput.identity,
        spawnToken: launchInput.spawnToken,
        store: input.store,
        resolveWorkspacePath: input.resolveWorkspacePath,
        resolveEnvironment: input.resolveEnvironment
      }),
    readProcessStartTime: input.readProcessStartTime,
    ...(input.openConnection ? { openConnection: input.openConnection } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {})
  })
}

export async function resolveAcpStructuredLaunch(input: {
  identity: AgentSessionJournalIdentity
  spawnToken: string
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
}): Promise<AcpJsonRpcLaunch> {
  const recipe = acpSpawnRecipe(input.identity.agent)
  if (!recipe) {
    throw new Error(`ACP Chat UI does not support ${input.identity.agent}`)
  }
  const record = input.store.getRecord(input.identity.sessionId)
  if (record && record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    throw new Error(
      `ACP structured sessions run on the local host, not ${record.location.executionHostId}`
    )
  }
  const workspacePath = await input.resolveWorkspacePath(input.identity.workspaceId)
  const environment = await input.resolveEnvironment()
  const homeVariable = record?.accountHome.variable ?? acpAccountHomeVariable(input.identity.agent)
  const homePath = record?.accountHome.path
  return {
    command: recipe.program,
    args: [...recipe.args],
    cwd: workspacePath,
    env: {
      ...(environment as Record<string, string>),
      ...(homeVariable && homePath ? { [homeVariable]: homePath } : {}),
      [CODEX_SPAWN_TOKEN_ENV]: input.spawnToken
    }
  }
}
