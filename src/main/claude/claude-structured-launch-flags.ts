import type {
  NativeChatVisualsLaunch,
  PrepareNativeChatVisuals
} from '../native-chat/native-chat-visuals-delivery'
import {
  CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS,
  CLAUDE_PLUGIN_DIR_FLAG,
  CLAUDE_THINKING_DISPLAY_FLAG,
  type ClaudeCliFlagSupport,
  type ClaudeCliLaunch
} from './claude-cli-flag-support'

const THINKING_DISPLAY_ARGS: Readonly<Record<string, string>> = { 'thinking-display': 'summarized' }

/** Read cached version support after the longer visuals check. */
const THINKING_RECHECK_BUDGET_MS = 250

export type ClaudeLaunchFlags = {
  /** Show thinking text without enabling thinking for users who disabled it. */
  thinkingDisplayArgs: Readonly<Record<string, string>>
  visuals: { visuals: NativeChatVisualsLaunch; pluginDir: string | null } | null
}

export async function resolveClaudeLaunchFlags(
  deps: {
    cliFlags?: Pick<ClaudeCliFlagSupport, 'supports'>
    prepareVisuals?: PrepareNativeChatVisuals
  },
  sessionId: string,
  launch: ClaudeCliLaunch
): Promise<ClaudeLaunchFlags> {
  const thinking = (budgetMs?: number, startProbe?: boolean) =>
    deps.cliFlags?.supports(CLAUDE_THINKING_DISPLAY_FLAG, launch, budgetMs, startProbe) ?? false
  // A missed plugin probe disables the skill for the session, so allow the full probe timeout.
  const preparedVisuals = deps.prepareVisuals?.(sessionId) ?? Promise.resolve(null)
  const [thinksFirst, visuals, loadsPlugins] = await Promise.all([
    thinking(),
    preparedVisuals,
    preparedVisuals.then((visuals) =>
      visuals
        ? (deps.cliFlags?.supports(
            CLAUDE_PLUGIN_DIR_FLAG,
            launch,
            CLAUDE_CLI_FLAG_PROBE_KILL_AFTER_MS
          ) ?? false)
        : false
    )
  ])
  // Reuse any version learned by the plugin check without starting a new probe.
  const thinks =
    thinksFirst || (visuals ? await thinking(THINKING_RECHECK_BUDGET_MS, false) : false)
  return {
    thinkingDisplayArgs: thinks ? THINKING_DISPLAY_ARGS : {},
    visuals: visuals ? { visuals, pluginDir: loadsPlugins ? visuals.skill.pluginDir : null } : null
  }
}
