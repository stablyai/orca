// Which credential directory a *terminal* Claude launch runs against.
//
// The same answer as a structured session, from the same resolver: a project-group binding
// outranks every other source, and an unusable one refuses rather than falling back. There is
// deliberately no second precedence ladder here — a terminal and a structured session disagreeing
// about which account a group runs under is exactly the silent-wrong-account failure the binding
// exists to prevent, and two ladders is how they would come to disagree.
//
// Kept out of the runtime class files for the reason `claude-structured-account-home.ts` already
// states: those are `@ts-nocheck`, so a call site written there would compile however wrong it
// was, and the wrong answer here is another organisation's account.

import type { Repo } from '../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { AssertClaudeBoundHomeUsable } from './claude-bound-home-refusal'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  claudeChildLaunchEnv,
  isEffectiveBoundClaudeHome,
  resolveClaudeStructuredAccountHome,
  type ClaudeHomeBindingCatalogSource
} from './claude-structured-account-home'

/**
 * The terminal agents whose CLI reads CLAUDE_CONFIG_DIR.
 *
 * `claude-agent-teams` launches the same binary behind a shim, so it reads the same credentials
 * and must honour the same binding; leaving it out would make the teams launcher the one way to
 * run a bound group against another account.
 */
const CLAUDE_CONFIG_DIR_TUI_AGENTS: ReadonlySet<string> = new Set(['claude', 'claude-agent-teams'])

export function terminalAgentReadsClaudeConfigDir(agent: TuiAgent | null | undefined): boolean {
  return typeof agent === 'string' && CLAUDE_CONFIG_DIR_TUI_AGENTS.has(agent)
}

/** `executionHostId` is nullable because a remote scope may not have resolved one; a scope that
 *  cannot name itself local is treated as not local, which is the safe direction here. */
export type ClaudeTerminalHomeLocation = {
  executionHostId: ExecutionHostId | null
  wslDistro: string | null
  workspaceId: string
}

/**
 * The WSL distro a local workspace routes through, by the same two signals the structured
 * location resolver uses: the repo's configured project runtime, then — for a folder workspace,
 * which has no repo Git options — a UNC path, the only durable signal left.
 */
export function resolveClaudeTerminalWslDistro(input: {
  store: { getRepo?: (repoId: string) => Repo | undefined } | null | undefined
  repo: Pick<Repo, 'id'> | null | undefined
  workspacePath: string
  isLocalHost: boolean
}): string | null {
  if (!input.isLocalHost) {
    return null
  }
  if (input.repo && input.store) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the options reader takes the same store shape the runtime passes its structured counterpart.
    const configured = getLocalProjectWorktreeGitOptions(
      input.store as Parameters<typeof getLocalProjectWorktreeGitOptions>[0],
      input.repo as Repo
    ).wslDistro
    if (configured) {
      return configured
    }
  }
  return parseWslUncPath(input.workspacePath)?.distro ?? null
}

/**
 * The CLAUDE_CONFIG_DIR patch a terminal launch must carry, or `{}` when this launch has no
 * business pinning one.
 *
 * Emits **only** for a group binding. An unbound launch returns nothing even when an account is
 * selected, because the managed-account selector deliberately swaps per-account auth rather than
 * the config dir (`global-settings-types.ts`) — pinning it here would fork Claude's shared chat
 * and session context behind the user's back, which is a different bug, not a stricter fix.
 */
export async function resolveClaudeTerminalConfigDirEnv(input: {
  agent: TuiAgent | null | undefined
  store: ClaudeHomeBindingCatalogSource
  location: ClaudeTerminalHomeLocation
  launchEnv: NodeJS.ProcessEnv
  readSelectedConfigDir: () => string | undefined
  assertBoundHomeUsable?: AssertClaudeBoundHomeUsable
}): Promise<{ CLAUDE_CONFIG_DIR?: string }> {
  if (!terminalAgentReadsClaudeConfigDir(input.agent)) {
    return {}
  }
  // A binding is a filesystem path on exactly one machine. A remote or WSL workspace cannot read
  // it, and refusing there would take away Claude terminals that work today against the remote's
  // own account — a regression the local binding does not justify. Same boundary
  // `assertClaudeBoundHomeUsable` draws, applied before it can refuse rather than after.
  if (input.location.executionHostId !== LOCAL_EXECUTION_HOST_ID || input.location.wslDistro) {
    return {}
  }
  const childEnv = claudeChildLaunchEnv(input.launchEnv)
  const accountHome = await resolveClaudeStructuredAccountHome({
    store: input.store,
    location: { ...input.location, executionHostId: LOCAL_EXECUTION_HOST_ID },
    launchEnv: input.launchEnv,
    readSelectedConfigDir: input.readSelectedConfigDir,
    ...(input.assertBoundHomeUsable ? { assertBoundHomeUsable: input.assertBoundHomeUsable } : {})
  })
  if (!isEffectiveBoundClaudeHome(accountHome, { env: childEnv })) {
    return {}
  }
  return claudeConfigDirEnvPatch(accountHome.path, { env: childEnv })
}
