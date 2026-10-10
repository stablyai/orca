// How a durable session record becomes a ZCode process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered the acquire. A resume names the session this
// record actually proved — the provider-handle chain head — never one a caller
// asks for, which is how a resume becomes a fork wearing a resume's name.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { resolveAgentSessionLaunchDirectory } from '../runtime/agent-session-launch-directory'
import { ZCODE_STRUCTURED_AGENT } from './zcode-structured-agent-definition'

export type ZcodeStructuredLaunch = {
  command: string
  args: string[]
  cwd: string
  /** The account home the session pinned, laid over the child env as ZCODE_HOME. */
  zcodeHome: string | null
  env?: Record<string, string>
  /** Present when the record's handle chain holds a head: the ZCode session id to resume. */
  resumeSessionId: string | null
  /** The workspace directory the session's `session/create` names. */
  workspacePath: string
}

export type ZcodeStructuredLaunchResolverDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'pinLaunchDirectory'>
  /** Absolute path of a workspace on this host. Rejects when the workspace no
   *  longer resolves, which is the case a stale mobile client hits. */
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Overridden in tests; production scans the boot-cached PATH and version-manager dirs. */
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Fresh shell/configured environment for this spawn; never written to the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
}

export function createZcodeStructuredLaunchResolver(
  deps: ZcodeStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<ZcodeStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error(`no durable agent-session record for ${identity.sessionId}`)
    }
    const { location } = record
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    if (record.provider !== 'zcode') {
      throw new Error(`session ${identity.sessionId} is a ${record.provider} session`)
    }
    // This adapter spawns a child on the machine the runtime itself runs on.
    // A session pinned elsewhere belongs to that host's runtime, and quietly
    // starting it here would put a second writer on the same conversation.
    if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
      throw new Error(
        `zcode structured sessions run on the local host, not ${location.executionHostId}`
      )
    }
    const pinned = ZCODE_STRUCTURED_AGENT.accountHomeVariable
    if (accountHome.variable !== pinned) {
      throw new Error(`zcode sessions pin ${pinned}, not ${accountHome.variable}`)
    }
    const environment = await deps.resolveEnvironment?.()
    const pathEnv = environment?.PATH ?? environment?.Path ?? null
    const homePath = environment?.HOME ?? environment?.USERPROFILE
    const command = (deps.resolveCommand ?? resolveZcodeCommand)({
      pathEnv,
      ...(homePath ? { homePath } : {})
    })
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    const resumeSessionId = head?.handle.nativeId ?? null
    const workspacePath = await resolveAgentSessionLaunchDirectory(deps, record)
    return {
      command,
      args: ['app-server', '--stdio'],
      cwd: workspacePath,
      zcodeHome: accountHome.path,
      ...(environment ? { env: launchEnv(environment) } : {}),
      resumeSessionId,
      workspacePath
    }
  }
}

/** Keeps only string-valued env entries, dropping undefined holes a ProcessEnv can carry. */
function launchEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
  const entries = Object.entries(environment).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  return Object.fromEntries(entries)
}

/** PATH first, then the version-manager and system install directories the shared resolver scans. */
export function resolveZcodeCommand(options?: {
  pathEnv?: string | null
  homePath?: string
}): string {
  return resolveCliCommand('zcode', options)
}
