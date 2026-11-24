import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PipelineV2LaunchEnvironment } from './pipeline-v2-launch'
import type { PipelineV2LaunchRequest } from './pipeline-v2-execution'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readPipelineV2TerminalOptions } from './pipeline-v2-session-compatibility'

export type PipelineV2SessionObservation = {
  agent?: string
  surface?: string
  permissionMode?: string
  model?: string
  effort?: string
}
export function pipelineV2LaunchEnvironment(
  runtime: OrcaRuntimeService
): PipelineV2LaunchEnvironment {
  return {
    settings: runtime.requireStore().getSettings(),
    terminalModelSupport: (agent, model, workspace) =>
      agent === 'opencode'
        ? runtime.probeOrchestrationOpenCodeModelLaunchSupport({
            worktree: `id:${workspace.id}`,
            model
          })
        : Promise.resolve(false),
    catalog: async (agent, workspacePath) => {
      const catalog = await runtime.structuredAgentModelCatalog()
      if (!catalog) {
        return { origin: 'unknown' }
      }
      return catalog.read({ agent, workspacePath, waitForListing: true, verifiedOnly: true })
    },
    chatSupport: (agent, workspace) =>
      runtime.getStructuredAgentSessionCreateSupport(`id:${workspace.id}`, agent, {
        requireInstalledChatProgram: true
      })
  }
}
export async function readPipelineV2SessionExecutor(
  runtime: OrcaRuntimeService,
  request: PipelineV2LaunchRequest
): Promise<PipelineV2SessionObservation> {
  const session = request.previousSession
  if (!session) {
    throw new Error('pipeline_session_options_unverifiable')
  }
  const policy =
    request.executor.permissionMode === 'default' ? 'own' : request.executor.permissionMode
  if (session.kind === 'structured') {
    await runtime.ensureStructuredAgentSessionHost()
    const host = getStructuredAgentSessionHost()
    const record = host?.deps.store.getConversation(session.sessionId)
    if (!host || !record) {
      throw new Error('pipeline_session_options_unverifiable')
    }
    const { current } = await host.readOptions(session.sessionId)
    const permission = current.permissionMode
    return {
      agent: record.provider,
      surface: 'chat',
      ...(typeof current.model === 'string' ? { model: current.model } : {}),
      ...(typeof current.effort === 'string' ? { effort: current.effort } : {}),
      ...(policy === 'own'
        ? { permissionMode: 'own' }
        : typeof permission === 'string'
          ? { permissionMode: permission }
          : {})
    }
  }
  if (session.kind !== 'terminal' || !session.terminalHandle) {
    throw new Error('pipeline_session_options_unverifiable')
  }
  const shown = await runtime.showTerminal(session.terminalHandle)
  if (shown.worktreeId !== request.workspace.id || !shown.writable || !shown.connected) {
    throw new Error('pipeline_session_conflict')
  }
  const catalog = await pipelineV2LaunchEnvironment(runtime).catalog(
    request.executor.agent,
    request.workspace.path
  )
  const frame = await runtime.readTerminal(session.terminalHandle, { screen: true, limit: 24 })
  return {
    agent: shown.agentIdentity,
    surface: 'terminal',
    ...readPipelineV2TerminalOptions(frame, catalog),
    ...(policy === 'own' ? { permissionMode: 'own' } : {})
  }
}
