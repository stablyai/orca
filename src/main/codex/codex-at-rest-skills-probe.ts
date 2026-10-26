import { PrioritySemaphore } from '../../shared/priority-semaphore'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  isLegacyAgentSessionAccountHome,
  requireLegacyAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../native-chat/native-chat-visuals-delivery'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { runCodexAppServerSession } from './codex-app-server-session'
import { isCodexSkillsListUnsupported, requestCodexSkillReport } from './codex-skill-list'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { resolveHiddenRateLimitPtyCwd } from '../rate-limits/hidden-rate-limit-pty-cwd'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from './codex-structured-launch-resolution'

const ANSWER_TIMEOUT_MS = 15_000
/** Startup grace for plugin sync; longer sync can still be interrupted and retain staging. */
export const CODEX_SKILLS_PROBE_SETTLE_MS = 70_000
/** Bounds unanswered probes only; answered probes can still be settling. */
const MAX_PROBES_ANSWERING = 2

export type CodexAtRestSkillsDeps = CodexStructuredInvocationDeps & {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Apply launch-time home sync so the probe sees the same configuration. */
  prepareHome?: (home: string) => void
  now?: () => number
  runSession?: typeof runCodexAppServerSession
  sleep?: (ms: number) => Promise<void>
}

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/** Reports launch-folder skills before plugin startup grace expires; sync may still be unfinished. */
export function createCodexAtRestSkillCatalog(deps: CodexAtRestSkillsDeps): AtRestCommandCatalog {
  const answering = new PrioritySemaphore(MAX_PROBES_ANSWERING)
  return new AtRestCommandCatalog({
    label: 'codex',
    accepts: (record) =>
      record.provider === 'codex' &&
      supportsCodexStructuredLocation(record.location) &&
      isLegacyAgentSessionAccountHome(record.accountHome),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    scan: async (record, cwd, isCurrent) => {
      const acquired = await answering.acquire(0)
      let released = false
      const release = (): void => {
        if (!released) {
          released = true
          acquired()
        }
      }
      try {
        return isCurrent()
          ? await probeCodexSkills(deps, record, cwd, release, isCurrent)
          : { commands: undefined, fromAgent: false }
      } finally {
        release()
      }
    },
    ...(deps.now ? { now: deps.now } : {})
  })
}

async function probeCodexSkills(
  deps: CodexAtRestSkillsDeps,
  record: AgentSessionRecord,
  cwd: string,
  releaseSlot: () => void,
  isCurrent: () => boolean
): Promise<AtRestCommandScan> {
  const accountHomePath = requireLegacyAgentSessionAccountHome(record.accountHome).path
  const { command, environment } = await resolveCodexStructuredInvocation({
    ...deps,
    resolveWorkingDirectory: () => cwd
  })
  const args = codexStructuredLaunchArgs(await deps.resolveLaunchArgs())
  if (!isCurrent()) {
    return { commands: undefined, fromAgent: false }
  }
  deps.prepareHome?.(accountHomePath)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepFor
  const spawnedAt = now()
  const answer = Promise.withResolvers<AtRestCommandScan>()
  void (deps.runSession ?? runCodexAppServerSession)(
    {
      command,
      args: [...args, 'app-server'],
      // skills/list takes the folder per request; a settling probe in it blocks Windows worktree removal (#33174).
      cwd: resolveHiddenRateLimitPtyCwd(),
      cliPath: command,
      env: { ...definedEnv(environment), CODEX_HOME: accountHomePath },
      envToDelete: [NATIVE_CHAT_SCRATCH_DIR_ENV, LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV],
      timeoutMs: CODEX_SKILLS_PROBE_SETTLE_MS + ANSWER_TIMEOUT_MS,
      treeKillOnFinish: true
    },
    async (rpc) => {
      try {
        answer.resolve({
          commands: await requestCodexSkillReport(rpc, cwd, { timeoutMs: ANSWER_TIMEOUT_MS }),
          fromAgent: true
        })
      } catch (error) {
        if (!isCodexSkillsListUnsupported(error)) {
          answer.reject(error)
          return
        }
        // An older Codex has no list to give; the client keeps its folder scan.
        answer.resolve({ commands: undefined, fromAgent: true })
      } finally {
        // Settling holds a process, not an answering permit, including after a list failure.
        releaseSlot()
        await sleep(spawnedAt + CODEX_SKILLS_PROBE_SETTLE_MS - now())
      }
    }
  ).catch(answer.reject)
  return answer.promise
}
