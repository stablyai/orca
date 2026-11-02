import { randomBytes } from 'node:crypto'
import { agentHookServer } from '../../../agent-hooks/server'
import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  SAVED_RESTORE_BUDGET_ENV,
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_FRESH_ARGS_ENV,
  withSavedRestoreProof
} from '../../../../shared/saved-restore-dispatch'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../../shared/tui-agent-startup-shell'
import { prependOrcaCliDirToChildPath } from '../../../cli/orca-cli-child-path'
import type { ResumeSpawnAdmission } from '../host-env/saved-resume-admission'
import type { PtySpawnOperationState } from '../spawn-operation-state'
import { isWslTerminalSpawn } from '../wsl-terminal-spawn'
import {
  buildSavedResumeFreshCommand,
  SEQUENCED_STARTUP_ENV,
  type SavedResumeLaunchFacts
} from './saved-resume-fresh-launch'
import { mintSavedRestoreReceipt } from './saved-restore-receipt'

// Agents whose store is chosen by env inside the pane: their own shell function checks it there.
const IN_PANE_AGENTS = new Set(['codex', 'claude', 'opencode', 'opencode2'])
/** From the CLI's own start; main bounds its store read by what remains. */
export const SAVED_RESTORE_CHECK_BUDGET_MS = 4_000
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

type SplitCommand = { lead: string[]; agent: string; args: string[] }

/** The words before the agent, the agent word and its arguments, when the shell runs exactly
 *  those words as one simple command; anything compound gets no check. */
function splitAgentCommand(command: string, shell: AgentStartupShell): SplitCommand | null {
  // PowerShell's call operator runs the named command, Orca's function included.
  const call = shell === 'powershell' && command.startsWith('& ')
  const parsed = tokenizeStartupCommand(call ? command.slice(2) : command, shell)
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    return null
  }
  const lead: string[] = call ? ['&'] : []
  let index = 0
  while (shell !== 'powershell' && ASSIGNMENT.test(parsed.tokens[index] ?? '')) {
    lead.push(parsed.tokens[index++])
  }
  const agent = parsed.tokens[index]
  return agent ? { lead, agent, args: parsed.tokens.slice(index + 1) } : null
}

function freshArgsValue(args: string[], shell: AgentStartupShell): string {
  return shell === 'powershell'
    ? JSON.stringify(args)
    : args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
}

function orcaCliLauncher(): string | null {
  const app = getAppEnvironment()
  return prependOrcaCliDirToChildPath(
    {},
    {
      isPackaged: app.isPackaged(),
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData')
    }
  )
}

/** A synthesized saved restore of an agent whose store the pane's env selects keeps its resume
 *  command; the agent's own function asks main, from inside the invocation, whether to run the
 *  prebuilt fresh arguments instead. Only this generated line carries the one-shot proof. */
export async function armSavedRestoreCheck(
  ctx: PtySpawnOperationState,
  paneKey: string | null,
  launch: SavedResumeLaunchFacts | undefined,
  admission: ResumeSpawnAdmission | null
): Promise<void> {
  const args = ctx.args
  const agent = args.launchAgent
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const env = ctx.spawnOptions.env ?? {}
  const resume = ctx.spawnOptions.command
  if (
    !launch ||
    !paneKey ||
    admission?.verdict !== 'admitted' ||
    args.resumeOrigin !== 'saved' ||
    !agent ||
    !IN_PANE_AGENTS.has(agent) ||
    !isResumableTuiAgent(agent) ||
    !providerSession ||
    !resume ||
    args.connectionId ||
    ctx.expectedWslDistro !== null ||
    isWslTerminalSpawn(launch.shellOverride, ctx.cwd) ||
    SEQUENCED_STARTUP_ENV.some((key) => env[key] !== undefined || args.env?.[key] !== undefined) ||
    // At mint the row must be this pane's launch seed: a hook since means the agent ran.
    !agentHookServer.captureLaunchSeed(paneKey, agent, providerSession)
  ) {
    return
  }
  const fresh = await buildSavedResumeFreshCommand(
    ctx,
    launch,
    agent,
    admission.sourceRecord?.launchConfig ?? args.launchConfig
  )
  if (!fresh || fresh.shell === 'cmd') {
    return
  }
  const resumeWords = splitAgentCommand(resume, fresh.shell)
  const freshWords = splitAgentCommand(fresh.command, fresh.shell)
  const launcher = orcaCliLauncher()
  if (
    !launcher ||
    !resumeWords ||
    !freshWords ||
    resumeWords.agent !== agent ||
    freshWords.agent !== agent ||
    resumeWords.lead.join('\0') !== freshWords.lead.join('\0')
  ) {
    return
  }
  const proof = randomBytes(16).toString('hex')
  mintSavedRestoreReceipt(proof, {
    paneKey,
    agent,
    providerSession,
    resumeArgs: resumeWords.args,
    worktreeId: args.worktreeId,
    admission,
    settings: ctx.deps.getSettings?.()
  })
  ctx.savedRestoreProof = proof
  ctx.spawnOptions.env = {
    ...env,
    [SAVED_RESTORE_CHECK_ENV]: launcher,
    [SAVED_RESTORE_FRESH_ARGS_ENV]: freshArgsValue(freshWords.args, fresh.shell),
    [SAVED_RESTORE_BUDGET_ENV]: String(SAVED_RESTORE_CHECK_BUDGET_MS)
  }
  ctx.spawnOptions.command = withSavedRestoreProof(
    resume,
    proof,
    fresh.shell === 'powershell' ? 'powershell' : 'posix'
  )
}
