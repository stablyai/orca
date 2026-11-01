import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { createHash } from 'node:crypto'
import * as Pools from './codex-at-rest-skills-probe-pools'
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
import { runCodexAppServerSession, type CodexAppServerRpc } from './codex-app-server-session'
import {
  CODEX_SKILLS_LIST_METHOD,
  codexFolderSkillReport,
  codexSkillRows,
  codexReportCommandRows,
  isCodexSkillsListUnsupported
} from './codex-skill-list'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { resolveHiddenProbeCwd } from '../rate-limits/hidden-probe-cwd'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from './codex-structured-launch-resolution'

const ANSWER_TIMEOUT_MS = 15_000
/** Startup grace for plugin sync; longer sync can still be interrupted and retain staging. */
export const CODEX_SKILLS_PROBE_SETTLE_MS = 70_000
const MAX_FOLDERS_PER_REQUEST = 8

export type CodexAtRestSkillsDeps = CodexStructuredInvocationDeps & {
  resolveLaunchArgs: () => Promise<string[]> | string[]
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Apply launch-time home sync so the probe sees the same configuration. */
  prepareHome?: (home: string) => void
  now?: () => number
  runSession?: typeof runCodexAppServerSession
  sleep?: (ms: number) => Promise<void>
}

const NO_SCAN: AtRestCommandScan = { commands: undefined, fromAgent: false }

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

/** Reports launch-folder skills before plugin startup grace expires; sync may still be unfinished. */
export function createCodexAtRestSkillCatalog(deps: CodexAtRestSkillsDeps): AtRestCommandCatalog {
  const now = deps.now ?? Date.now
  const { pools, start, expire, dispose } = Pools.createCodexSkillsProbePools(deps, probe)

  return new AtRestCommandCatalog({
    label: 'codex',
    accepts: (record) =>
      record.provider === 'codex' &&
      supportsCodexStructuredLocation(record.location) &&
      isLegacyAgentSessionAccountHome(record.accountHome),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    dispose,
    scan: async (record, cwd, isCurrent, generation, signal, admitted) => {
      const accountHomePath = requireLegacyAgentSessionAccountHome(record.accountHome).path
      const { command, prefixArgs, environment } = await resolveCodexStructuredInvocation({
        ...deps,
        signal,
        resolveWorkingDirectory: () => cwd
      })
      const args = [
        ...prefixArgs,
        ...codexStructuredLaunchArgs(
          await waitForPromiseWithSignal(Promise.resolve(deps.resolveLaunchArgs()), signal)
        )
      ]
      if (!isCurrent()) {
        return NO_SCAN
      }
      const env = definedEnv(environment)
      const key = JSON.stringify([
        accountHomePath,
        command,
        args,
        createHash('sha256')
          .update(JSON.stringify(Object.entries(env).sort()))
          .digest('hex')
      ])
      const pool = pools.get(key) ?? { failedStarts: 0, retryAt: 0, lastDemandAt: now() }
      pools.set(key, pool)
      pool.lastDemandAt = now()
      if (!pool.owner && now() < pool.retryAt) {
        expire(key, pool)
        throw new Error('codex app-server could not start recently; waiting before trying again')
      }
      const owner = pool.owner ?? {
        accountHomePath,
        command,
        args,
        environment: env,
        pending: new Set<Pools.FolderRequest>(),
        active: new Set<Pools.FolderRequest>(),
        controller: new AbortController(),
        started: false
      }
      const request: Pools.FolderRequest = {
        cwd,
        generation,
        isCurrent,
        admitted,
        answer: Promise.withResolvers<AtRestCommandScan>(),
        cancel: () => signal.removeEventListener('abort', onAbort),
        done: false
      }
      const onAbort = (): void => {
        owner.pending.delete(request)
        owner.active.delete(request)
        Pools.settle(
          request,
          signal.reason instanceof Error ? signal.reason : new Error('Command discovery stopped')
        )
        const current = pool.owner
        if (
          current &&
          !current.started &&
          current.pending.size === 0 &&
          current.active.size === 0
        ) {
          current.controller.abort()
        }
        current?.wake?.()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      owner.pending.add(request)
      if (!pool.owner) {
        start(key, pool, owner)
      } else {
        owner.wake?.()
      }
      return request.answer.promise
    },
    ...(deps.now ? { now: deps.now } : {})
  })
}
export async function probe(
  deps: CodexAtRestSkillsDeps,
  pool: Pools.ProbeOwner,
  spawnedAt: number,
  onStarted: () => void
): Promise<void> {
  const now = deps.now ?? Date.now
  let reloaded = Math.max(...[...pool.pending].map((request) => request.generation))
  await (deps.runSession ?? runCodexAppServerSession)(
    {
      command: pool.command,
      args: [...pool.args, 'app-server'],
      // skills/list takes the folder per request; a settling probe in it blocks Windows worktree removal (#33174).
      cwd: resolveHiddenProbeCwd(),
      cliPath: pool.command,
      env: { ...pool.environment, CODEX_HOME: pool.accountHomePath },
      envToDelete: [NATIVE_CHAT_SCRATCH_DIR_ENV, LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV],
      // The last request can start just before the grace ends.
      timeoutMs: CODEX_SKILLS_PROBE_SETTLE_MS + 2 * ANSWER_TIMEOUT_MS,
      treeKillOnFinish: true,
      signal: pool.controller.signal
    },
    async (rpc) => {
      const signal = rpc.signal
        ? AbortSignal.any([rpc.signal, pool.controller.signal])
        : pool.controller.signal
      signal.throwIfAborted()
      const sleep = deps.sleep ?? ((ms: number) => delayUnlessAborted(Math.max(0, ms), signal))
      onStarted()
      const graceEnded = sleep(spawnedAt + CODEX_SKILLS_PROBE_SETTLE_MS - now()).then(() => false)
      let answered = false
      for (;;) {
        const remaining = spawnedAt + CODEX_SKILLS_PROBE_SETTLE_MS - now()
        signal.throwIfAborted()
        if (remaining <= 0 && answered) {
          return
        }
        const batch: Pools.FolderRequest[] = []
        pool.cursor ??= pool.pending.values()
        while (batch.length < MAX_FOLDERS_PER_REQUEST) {
          const request = pool.cursor.next().value
          if (!request) {
            break
          }
          pool.pending.delete(request)
          if (request.isCurrent()) {
            pool.active.add(request)
            batch.push(request)
          } else {
            Pools.settle(request, NO_SCAN)
          }
        }
        if (pool.pending.size === 0) {
          pool.cursor = undefined
        }
        if (batch.length > 0) {
          const forceReload = batch.some((request) => request.generation > reloaded)
          try {
            deps.prepareHome?.(pool.accountHomePath)
            batch.forEach((request) => request.admitted())
            if (await answer(rpc, batch, forceReload, signal)) {
              reloaded = Math.max(reloaded, ...batch.map((request) => request.generation))
            }
          } catch (error) {
            batch.forEach((request) =>
              Pools.settle(request, error instanceof Error ? error : new Error(String(error)))
            )
          } finally {
            batch.forEach((request) => pool.active.delete(request))
          }
          signal.throwIfAborted()
          answered = true
          continue
        }
        if (remaining <= 0) {
          return
        }
        const woken = await Promise.race([
          graceEnded,
          new Promise<boolean>((resolve) => {
            pool.wake = () => resolve(true)
          })
        ])
        pool.wake = undefined
        if (!woken) {
          return
        }
      }
    }
  )
}

async function answer(
  rpc: CodexAppServerRpc,
  batch: Pools.FolderRequest[],
  forceReload: boolean,
  signal: AbortSignal
): Promise<boolean> {
  let reply: unknown
  try {
    reply = await rpc.request(
      CODEX_SKILLS_LIST_METHOD,
      { cwds: batch.map((request) => request.cwd), ...(forceReload ? { forceReload: true } : {}) },
      { timeoutMs: ANSWER_TIMEOUT_MS }
    )
  } catch (error) {
    if (isCodexSkillsListUnsupported(error)) {
      // An older Codex has no list to give; the client keeps its folder scan.
      batch.forEach((request) => Pools.settle(request, { commands: undefined, fromAgent: true }))
      return false
    }
    // The process still settles: ending it early would interrupt plugin sync, including after a list failure.
    batch.forEach((request) =>
      Pools.settle(request, error instanceof Error ? error : new Error(String(error)))
    )
    return false
  }
  signal.throwIfAborted()
  for (const request of batch) {
    if (!request.isCurrent()) {
      Pools.settle(request, NO_SCAN)
      continue
    }
    const commands =
      codexFolderSkillReport(reply, request.cwd) ??
      // Older replies may name a single folder differently.
      (batch.length === 1
        ? [...codexReportCommandRows(), ...codexSkillRows(reply, request.cwd)]
        : undefined)
    Pools.settle(
      request,
      commands
        ? { commands, fromAgent: true }
        : new Error(`codex listed no skills entry for ${request.cwd}`)
    )
  }
  return true
}
