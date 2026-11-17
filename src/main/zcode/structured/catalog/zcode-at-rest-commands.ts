import type { StructuredAgentCommandSettings } from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../../../native-chat/agent-session-wire/options/at-rest-command-catalog'
import type { AtRestCommandDemand } from '../../../native-chat/agent-session-wire/options/at-rest-command-demand'
import { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'
import { spawnZcodeAppServerConnection } from '../../../zcode/app-server/zcode-app-server-connection'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerServerRequest
} from '../../../zcode/app-server/zcode-app-server-connection-types'
import { supportsSupervisedProviderChildLocation } from '../../../provider-process/supervised-provider-child-location'
import { zcodeHeadlessLaunch } from '../launch/zcode-headless-launch'
import { requestZcodeSkillCatalog } from './zcode-skill-catalog'

// Resting zcode chats list their `/` skills over a disposable backend: the workspace-wide
// catalog needs no session, only the boot the live child would run. Other hosts scan their own
// workspaces, so nothing here may answer for a remote record.

const MAX_PROBES_RUNNING = 2
const CATALOG_TIMEOUT_MS = 30_000

export type ZcodeAtRestCommandsDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  now?: () => number
}

export class ZcodeAtRestCommandCatalog extends AtRestCommandCatalog {
  constructor(deps: ZcodeAtRestCommandsDeps) {
    const probes = new PrioritySemaphore(MAX_PROBES_RUNNING)
    super({
      label: 'zcode',
      accepts: (record: AgentSessionRecord) =>
        record.provider === 'zcode' && supportsSupervisedProviderChildLocation(record.location),
      resolveWorkspacePath: deps.resolveWorkspacePath,
      scan: (_record, cwd, isCurrent, _generation, signal, admitted, demand) =>
        scanZcodeAtRest(deps, cwd, isCurrent, signal, admitted, demand, probes),
      ...(deps.now ? { now: deps.now } : {})
    })
  }
}

async function scanZcodeAtRest(
  deps: ZcodeAtRestCommandsDeps,
  cwd: string,
  isCurrent: () => boolean,
  signal: AbortSignal,
  admitted: () => void,
  demand: AtRestCommandDemand,
  probes: PrioritySemaphore
): Promise<AtRestCommandScan> {
  const release = await demand.acquire(probes, signal)
  try {
    if (!isCurrent()) {
      return { commands: undefined, fromAgent: false }
    }
    admitted()
    const environment = await deps.resolveEnvironment()
    if (!isCurrent()) {
      return { commands: undefined, fromAgent: false }
    }
    const launch = await zcodeHeadlessLaunch(environment, {
      commandSettings: deps.resolveCommandSettings?.()
    })
    const connection = await spawnZcodeAppServerConnection(
      { command: launch.command, args: launch.args, cwd, env: launch.env },
      { onServerRequest: (request) => answerProbeAsk(connection, request) }
    )
    try {
      const commands = await requestZcodeSkillCatalog(
        connection,
        { workspace: { workspacePath: cwd, workspaceKey: cwd } },
        CATALOG_TIMEOUT_MS,
        () => signal.throwIfAborted()
      )
      return { commands: commands ?? [], fromAgent: true }
    } finally {
      await connection.close().catch(() => undefined)
    }
  } finally {
    release()
  }
}

/** The asks a booting backend sends before it can list anything. */
function answerProbeAsk(
  connection: ZcodeAppServerConnection,
  request: ZcodeAppServerServerRequest
) {
  if (request.method === 'session/requestRuntimePreferences') {
    connection.respond(request.id, {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false
    })
    return
  }
  connection.respondWithError(request.id, -32601, `Orca does not answer ${request.method}`)
}
