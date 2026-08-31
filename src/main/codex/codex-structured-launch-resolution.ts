// How a durable session record becomes a Codex process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered the acquire. A client that attaches twice must
// land in the same working directory under the same account home, and a resume
// must name the thread this session actually proved — never one a caller asks
// for, which is how a resume becomes a fork wearing a resume's name.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveCodexCommand } from '../codex-cli/command'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { CodexStructuredLaunch } from './codex-structured-session-adapter'
import { resolvePinnedCodexRolloutProof } from './codex-tui-rollout-proof'

export type CodexStructuredLaunchResolverDeps = {
  store: AgentSessionRecordStore
  /** Absolute path of a workspace on this host. Rejects when the workspace no
   *  longer resolves, which is the case a stale mobile client hits. */
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Overridden in tests; production scans the boot-cached PATH and version-manager dirs. */
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Fresh shell/configured environment for this spawn; never written to the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveRollout?: typeof resolvePinnedCodexRolloutProof
}

export function createCodexStructuredLaunchResolver(
  deps: CodexStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<CodexStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error(`no durable agent-session record for ${identity.sessionId}`)
    }
    const { location, accountHome } = record
    if (record.provider !== 'codex') {
      throw new Error(`session ${identity.sessionId} is a ${record.provider} session`)
    }
    // This adapter spawns a child on the machine the runtime itself runs on.
    // A session pinned elsewhere belongs to that host's runtime, and quietly
    // starting it here would put a second writer on the same thread.
    if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
      throw new Error(
        `codex structured sessions run on the local host, not ${location.executionHostId}`
      )
    }
    if (accountHome.variable !== 'CODEX_HOME') {
      throw new Error(`codex sessions pin CODEX_HOME, not ${accountHome.variable}`)
    }
    const environment = await deps.resolveEnvironment?.()
    const pathEnv = environment?.PATH ?? environment?.Path ?? null
    const homePath = environment?.HOME ?? environment?.USERPROFILE
    const command = (deps.resolveCommand ?? resolveCodexCommand)({
      pathEnv,
      ...(homePath ? { homePath } : {})
    })
    const args = [...(record.launchArgs ?? []), 'app-server']
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    const resumeThreadId = head?.handle.provider === 'codex' ? head.handle.threadId : null
    return {
      command,
      args,
      cwd: await deps.resolveWorkspacePath(location.workspaceId),
      codexHome: accountHome.path,
      ...(environment ? { env: { ...environment } as Record<string, string> } : {}),
      // An empty chain is a session that has never proved a thread, so it
      // starts one; anything else resumes the last link this session proved.
      resumeThreadId,
      ...(resumeThreadId
        ? {
            resumePath: await (deps.resolveRollout ?? resolvePinnedCodexRolloutProof)(
              accountHome.path,
              resumeThreadId
            )
          }
        : {})
    }
  }
}
