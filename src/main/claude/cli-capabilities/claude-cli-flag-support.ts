import { realpath, stat } from 'node:fs/promises'
import { defaultClaudeConfigDir } from '../structured/launch/claude-config-dir-pin'
import { claudeVersionReaches, probeClaudeCliVersion } from './claude-hook-event-versions'

export type ClaudeCliFlag = { readonly option: string; readonly firstVersion: string }

export const CLAUDE_THINKING_DISPLAY_FLAG: ClaudeCliFlag = {
  option: '--thinking-display',
  firstVersion: '2.1.94'
}

export const CLAUDE_PLUGIN_DIR_FLAG: ClaudeCliFlag = {
  option: '--plugin-dir',
  firstVersion: '2.0.25'
}

/** Claude loads the folders this variable names as plugins; managed settings can refuse it. */
export const CLAUDE_PLUGIN_DIRS_ENV: ClaudeCliFlag = {
  option: 'CLAUDE_CODE_PLUGIN_DIRS',
  firstVersion: '0.0.0'
}

/** A managed agent's own tools; managed settings can refuse it. */
export const CLAUDE_MCP_CONFIG_FLAG: ClaudeCliFlag = {
  option: '--mcp-config',
  firstVersion: '0.0.0'
}

export const CLAUDE_EFFORT_FLAG: ClaudeCliFlag = {
  option: '--effort',
  firstVersion: '2.1.38'
}

/** The control request behind live effort and Fast changes; older CLIs never answer it. */
export const CLAUDE_APPLY_FLAG_SETTINGS_CONTROL: ClaudeCliFlag = {
  option: 'apply_flag_settings',
  firstVersion: '2.1.50'
}

/** Suggestions are enabled only where they can be paused; each one costs a model request. */
export const CLAUDE_PROMPT_SUGGESTIONS_PAUSE_CONTROL: ClaudeCliFlag = {
  option: 'set_prompt_suggestions_paused',
  firstVersion: '2.1.280'
}

// Allow cold CLI startup without blocking for the full probe kill timeout.
export const CLAUDE_CLI_FLAG_PROBE_BUDGET_MS = 1_500

export const CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS = 10_000

/** Reads a version an earlier check or prewarm already learned. */
export const CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS = 250

// Only an explicit unknown-option or managed-settings refusal proves flag rejection.
const UNKNOWN_OPTION_DIAGNOSTIC = /unknown option '(--[a-z][a-z0-9-]*)'/
// Lists every refused item, e.g. `--plugin-dir, --agents, plugins (initialize request), CLAUDE_CODE_PLUGIN_DIRS are`.
const SIDELOAD_ITEM = String.raw`(?:--[a-z][a-z0-9-]*|[A-Z][A-Z0-9_]+|[a-z]+ \([a-z ]+\))`
const MANAGED_SIDELOAD_REFUSAL = new RegExp(
  String.raw`(?<![\w-])((?:${SIDELOAD_ITEM}, )*${SIDELOAD_ITEM}) (?:is|are) disabled by your organization's managed settings \(disableSideloadFlags\)`
)

// Managed settings can come from the signed-in account, so their refusals hold only for its config folder.
function refusedOptions(message: string): { options: string[]; perAccount: boolean } {
  const unknown = UNKNOWN_OPTION_DIAGNOSTIC.exec(message)?.[1]
  if (unknown) {
    return { options: [unknown], perAccount: false }
  }
  return {
    options: MANAGED_SIDELOAD_REFUSAL.exec(message)?.[1].split(', ') ?? [],
    perAccount: true
  }
}

/** Whether Claude exited because the organization's managed settings refuse `option`. */
export function claudeManagedSettingsRefuse(error: unknown, option: string): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const { options, perAccount } = refusedOptions(error.message)
  return perAccount && options.includes(option)
}

const MAX_REMEMBERED = 32

export type ClaudeCliLaunch = {
  command: string
  prefixArgs?: readonly string[]
  cwd: string
  env: Record<string, string>
}

type ClaudeVersionProbe = (
  command: string,
  launch: {
    cwd: string
    env: Record<string, string>
    timeoutMs: number
    prefixArgs?: readonly string[]
  }
) => Promise<string | null>

/** `unknown` when the version could not be read in budget: neither support nor its absence is proven. */
export type ClaudeCliFlagFact = 'supported' | 'unsupported' | 'unknown'

/** One launch's binary and cwd, bound for checks after it resolved. */
export type ClaudeCliFlagCheck = (
  flag: ClaudeCliFlag,
  budgetMs?: number,
  startProbe?: boolean
) => Promise<ClaudeCliFlagFact>

export type ClaudeCliFlagSupport = {
  /** Share probes by binary and cwd; budget expiry leaves the flag unknown for this launch only. */
  check: (
    flag: ClaudeCliFlag,
    launch: ClaudeCliLaunch,
    budgetMs?: number,
    /** False consults cached facts or an existing probe without starting another. */
    startProbe?: boolean
  ) => Promise<ClaudeCliFlagFact>
  /** Warm the version cache without waiting; failures remain retryable. */
  prewarm: (launch: ClaudeCliLaunch) => void
  /** Remember explicit flag rejection for this binary and cwd, and for the account if policy refused it. */
  observeExit: (
    launch: Pick<ClaudeCliLaunch, 'command' | 'prefixArgs' | 'cwd' | 'env'>,
    error: Error
  ) => void
}

// Key by resolved file, mtime and cwd to handle self-updates and project-specific shims.
async function claudeBinaryKey(command: string, cwd: string): Promise<string | null> {
  try {
    const target = await realpath(command)
    return `${target}\n${(await stat(target)).mtimeMs}\n${cwd}`
  } catch {
    return null
  }
}

async function within<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms))
    timer.unref?.()
  })
  try {
    return await Promise.race([pending, expired])
  } finally {
    clearTimeout(timer)
  }
}

type BinaryFacts = {
  version?: string
  refused: Set<string>
  refusedByAccount: Map<string, Set<string>>
}

export function createClaudeCliFlagSupport(
  deps: {
    probe: ClaudeVersionProbe
    keyOf: (command: string, cwd: string) => Promise<string | null>
    budgetMs: number
    now: () => number
  } = {
    probe: probeClaudeCliVersion,
    keyOf: claudeBinaryKey,
    budgetMs: CLAUDE_CLI_FLAG_PROBE_BUDGET_MS,
    now: () => performance.now()
  }
): ClaudeCliFlagSupport {
  const keyOf = async (launch: Pick<ClaudeCliLaunch, 'command' | 'prefixArgs' | 'cwd'>) => {
    const key = await deps.keyOf(launch.command, launch.cwd)
    return key === null ? null : JSON.stringify([key, launch.prefixArgs ?? []])
  }
  const known = new Map<string, BinaryFacts>()
  const probing = new Map<string, { settled: Promise<void>; startedAt: number }>()
  const touch = (key: string): BinaryFacts => {
    const facts = known.get(key) ?? {
      refused: new Set<string>(),
      refusedByAccount: new Map<string, Set<string>>()
    }
    known.delete(key)
    known.set(key, facts)
    for (const stale of known.keys()) {
      if (known.size <= MAX_REMEMBERED) {
        break
      }
      known.delete(stale)
    }
    return facts
  }
  // Failed probes stay retryable; cache only versions and explicit flag rejections.
  const settle = (key: string, version: string | null): void => {
    if (version !== null) {
      touch(key).version = version
    }
  }
  const versionOf = (key: string): string | undefined =>
    known.has(key) ? touch(key).version : undefined
  const answer = (key: string, flag: ClaudeCliFlag, launch: ClaudeCliLaunch): ClaudeCliFlagFact => {
    const facts = known.get(key)
    if (
      facts?.refused.has(flag.option) ||
      facts?.refusedByAccount.get(defaultClaudeConfigDir(launch.env))?.has(flag.option)
    ) {
      return 'unsupported'
    }
    if (facts?.version === undefined) {
      return 'unknown'
    }
    return claudeVersionReaches(facts.version, flag.firstVersion) ? 'supported' : 'unsupported'
  }
  const probe = (key: string, launch: ClaudeCliLaunch) => {
    const settled = deps
      .probe(launch.command, {
        cwd: launch.cwd,
        prefixArgs: launch.prefixArgs,
        env: launch.env,
        timeoutMs: CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS
      })
      .then(
        (version) => settle(key, version),
        () => settle(key, null)
      )
      .finally(() => probing.delete(key))
    const started = { settled, startedAt: deps.now() }
    probing.set(key, started)
    return started
  }

  return {
    check: async (flag, launch, budgetMs = deps.budgetMs, startProbe = true) => {
      // Include binary lookup in the launch's wait budget.
      const deadline = deps.now() + budgetMs
      const key = await within(keyOf(launch), budgetMs)
      if (key === undefined || key === null) {
        return 'unknown'
      }
      if (versionOf(key) !== undefined) {
        return answer(key, flag, launch)
      }
      const running = probing.get(key) ?? (startProbe ? probe(key, launch) : undefined)
      if (!running) {
        return answer(key, flag, launch)
      }
      // An already-running probe does not get a fresh wait budget.
      await within(running.settled, Math.min(running.startedAt + budgetMs, deadline) - deps.now())
      return answer(key, flag, launch)
    },
    prewarm: (launch) => {
      void keyOf(launch).then(
        (key) => {
          if (key !== null && versionOf(key) === undefined && !probing.has(key)) {
            probe(key, launch)
          }
        },
        () => {}
      )
    },
    observeExit: (launch, error) => {
      const { options, perAccount } = refusedOptions(error.message)
      if (options.length === 0) {
        return
      }
      void keyOf(launch).then((key) => {
        if (key === null) {
          return
        }
        const facts = touch(key)
        let refused = facts.refused
        if (perAccount) {
          const account = defaultClaudeConfigDir(launch.env)
          refused = facts.refusedByAccount.get(account) ?? new Set<string>()
          facts.refusedByAccount.set(account, refused)
        }
        options.forEach((option) => refused.add(option))
      })
    }
  }
}

export const claudeCliFlagSupport = createClaudeCliFlagSupport()
