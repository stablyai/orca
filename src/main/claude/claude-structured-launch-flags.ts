// The version-gated parts of a structured Claude launch: readable thinking, and the chat's visuals
// folder with its skill plugin. Both ask one shared version probe of the launch's own CLI.

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

/** How long the thinking flag is asked again once the visuals check has waited for the version:
 *  enough to find the binary and read the now-known answer. */
const THINKING_RECHECK_BUDGET_MS = 250

export type ClaudeLaunchFlags = {
  /** Readable thinking: the CLI otherwise streams thinking blocks with no text under Orca's
   *  launch. Only the display is set, never `--thinking`, so a user who turned thinking off keeps
   *  it off. */
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
  // Unlike the thinking display, a missed answer costs the chat its skill for its whole life, so
  // the plugin check waits for the probe up to its own kill time: bounded, and instant once known.
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
  // The plugin check may have outwaited the thinking budget and learned the version meanwhile; a
  // probe that gave none is not asked again here.
  const thinks =
    thinksFirst || (visuals ? await thinking(THINKING_RECHECK_BUDGET_MS, false) : false)
  return {
    thinkingDisplayArgs: thinks ? THINKING_DISPLAY_ARGS : {},
    visuals: visuals ? { visuals, pluginDir: loadsPlugins ? visuals.skill.pluginDir : null } : null
  }
}
