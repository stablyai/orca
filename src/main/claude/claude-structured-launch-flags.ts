import type {
  NativeChatVisualsLaunch,
  PrepareNativeChatVisuals
} from '../native-chat/native-chat-visuals-delivery'
import {
  CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS,
  CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS,
  CLAUDE_PLUGIN_DIR_FLAG,
  CLAUDE_THINKING_DISPLAY_FLAG,
  type ClaudeCliFlag,
  type ClaudeCliFlagFact,
  type ClaudeCliFlagSupport,
  type ClaudeCliLaunch
} from './claude-cli-flag-support'

const THINKING_DISPLAY_ARGS: Readonly<Record<string, string>> = { 'thinking-display': 'summarized' }

export type ClaudeLaunchFlags = {
  /** Show thinking text without enabling thinking for users who disabled it. */
  thinkingDisplayArgs: Readonly<Record<string, string>>
  visuals: { visuals: NativeChatVisualsLaunch; pluginDir: string | null } | null
}

export async function resolveClaudeLaunchFlags(
  deps: {
    cliFlags?: Pick<ClaudeCliFlagSupport, 'check'>
    prepareVisuals?: PrepareNativeChatVisuals
  },
  sessionId: string,
  launch: ClaudeCliLaunch
): Promise<ClaudeLaunchFlags> {
  const check = async (
    flag: ClaudeCliFlag,
    ...budget: [budgetMs?: number, startProbe?: boolean]
  ): Promise<ClaudeCliFlagFact> =>
    deps.cliFlags ? deps.cliFlags.check(flag, launch, ...budget) : 'unknown'
  const thinking = async (...budget: [budgetMs?: number, startProbe?: boolean]) =>
    (await check(CLAUDE_THINKING_DISPLAY_FLAG, ...budget)) === 'supported'
  // A missed plugin probe disables the skill for the session, so allow the full probe timeout.
  const preparedVisuals = deps.prepareVisuals?.(sessionId) ?? Promise.resolve(null)
  const [thinksFirst, visuals, loadsPlugins] = await Promise.all([
    thinking(),
    preparedVisuals,
    preparedVisuals.then(async (visuals) =>
      visuals
        ? (await check(CLAUDE_PLUGIN_DIR_FLAG, CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS)) === 'supported'
        : false
    )
  ])
  // Reuse any version learned by the plugin check without starting a new probe.
  const thinks =
    thinksFirst || (visuals ? await thinking(CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS, false) : false)
  return {
    thinkingDisplayArgs: thinks ? THINKING_DISPLAY_ARGS : {},
    visuals: visuals ? { visuals, pluginDir: loadsPlugins ? visuals.skill.pluginDir : null } : null
  }
}
