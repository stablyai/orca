// How a durable session record becomes a Codex process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered the acquire. A client that attaches twice must
// land in the same working directory under the same account home, and a resume
// must name the thread this session actually proved — never one a caller asks
// for, which is how a resume becomes a fork wearing a resume's name.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { realpath } from 'node:fs/promises'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveCodexCommand } from '../codex-cli/command'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { getSpawnArgsForWindows } from '../win32-utils'
import type { CodexStructuredLaunch } from './codex-structured-session-adapter'

const CODEX_APP_SERVER_ARGS = ['app-server']
export const CODEX_LOCAL_STRUCTURED_WRITE_ARGS = [
  '--disable',
  'apps',
  '--disable',
  'plugins',
  '--disable',
  'remote_plugin',
  '--disable',
  'plugin_sharing',
  '--disable',
  'computer_use',
  '--disable',
  'browser_use',
  '--disable',
  'browser_use_external',
  '--disable',
  'browser_use_full_cdp_access',
  '--disable',
  'in_app_browser',
  '--disable',
  'image_generation',
  '--disable',
  'artifact',
  '--disable',
  'multi_agent',
  '--disable',
  'skill_mcp_dependency_install',
  '--disable',
  'shell_tool',
  '--disable',
  'unified_exec',
  '--disable',
  'shell_snapshot',
  '--disable',
  'hooks',
  '--disable',
  'tool_suggest',
  '--disable',
  'skill_search',
  '--disable',
  'view_image',
  '--disable',
  'workspace_dependencies',
  '--disable',
  'auth_elicitation',
  '--disable',
  'tool_call_mcp_elicitation',
  '--disable',
  'standalone_web_search',
  '--disable',
  'web_search_request',
  '--disable',
  'web_search_cached',
  '--disable',
  'code_mode',
  '--disable',
  'code_mode_only',
  'app-server'
] as const

export type CodexStructuredLaunchResolverDeps = {
  store: AgentSessionRecordStore
  /** Absolute path of a workspace on this host. Rejects when the workspace no
   *  longer resolves, which is the case a stale mobile client hits. */
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Overridden in tests; production scans PATH and version-manager dirs. */
  resolveCommand?: () => string
  canonicalizePath?: (path: string) => Promise<string>
  localStructuredWriteOnly?: boolean
  resolveStructuredWriteSourceHome?: (sessionId: string) => Promise<string> | string
  prepareStructuredWriteHome?: (sessionId: string, sourceHome: string) => Promise<string>
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
    const command = (deps.resolveCommand ?? resolveCodexCommand)()
    const appServerArgs = deps.localStructuredWriteOnly
      ? [...CODEX_LOCAL_STRUCTURED_WRITE_ARGS]
      : CODEX_APP_SERVER_ARGS
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, appServerArgs)
    // Resolve the host-selected worktree before materialising credentials. A
    // stale workspace must fail without leaving a secret-bearing temp home.
    const cwd = await deps.resolveWorkspacePath(location.workspaceId)
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (deps.localStructuredWriteOnly && head) {
      throw new Error('structured writer cannot resume a thread whose effect isolation is unknown')
    }
    let codexHome = accountHome.path
    let isolatedHomePath: string | undefined
    if (deps.localStructuredWriteOnly) {
      if (!deps.resolveStructuredWriteSourceHome) {
        throw new Error('structured writer has no host-owned credential source provider')
      }
      if (!deps.prepareStructuredWriteHome) {
        throw new Error('structured writer has no isolated Codex home provider')
      }
      const sourceHome = await deps.resolveStructuredWriteSourceHome(identity.sessionId)
      const canonicalizePath = deps.canonicalizePath ?? realpath
      if ((await canonicalizePath(sourceHome)) !== (await canonicalizePath(accountHome.path))) {
        throw new Error('structured writer record does not match the host-owned credential source')
      }
      isolatedHomePath = await deps.prepareStructuredWriteHome(identity.sessionId, sourceHome)
      codexHome = isolatedHomePath
    }
    return {
      command: spawnCmd,
      args: spawnArgs,
      cwd,
      codexHome,
      ...(record.launchEnv ? { env: { ...record.launchEnv } } : {}),
      // An empty chain is a session that has never proved a thread, so it
      // starts one; anything else resumes the last link this session proved.
      resumeThreadId: head?.handle.provider === 'codex' ? head.handle.threadId : null,
      ...(deps.localStructuredWriteOnly
        ? { effectIsolation: 'local-structured-write' as const, isolatedHomePath }
        : {})
    }
  }
}
