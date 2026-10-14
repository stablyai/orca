import {
  CLICK_ELEMENT_TOOL_NAME,
  DESCRIBE_SCREEN_TOOL_NAME,
  READ_TERMINAL_TOOL_NAME,
  SEE_SCREEN_TOOL_NAME,
  TYPE_INTO_TOOL_NAME,
  type VoiceScreenSnapshot,
  type VoiceUiAction,
  type VoiceUiActionResult
} from '../../shared/voice-control-types'
import { formatVoiceScreenSnapshot } from './voice-control-screen-description'
import { readStringArg } from './voice-control-tool-arguments'
import type { VoiceToolResult } from './voice-control-tool-dispatch'

/**
 * The screen tools: describe_screen (store overview), see_screen (the real UI tree), and
 * click_element / type_into (acting on see_screen refs). Split from the main dispatch
 * (module size); `ctx` is exactly the slice of the dispatch context these tools need.
 */

export type VoiceScreenToolContext = {
  describeScreen: () => Promise<VoiceScreenSnapshot | null>
  seeScreen: () => Promise<string | null>
  performUiAction: (action: VoiceUiAction) => Promise<VoiceUiActionResult | null>
  /** read_terminal: the visible text of the terminal pane(s) on screen. */
  readTerminal: () => Promise<string | null>
}

const SCREEN_UNAVAILABLE =
  'The screen is not available right now — the window may be busy or DevTools may be holding its debugger. Try again in a moment.'

export async function runVoiceScreenTool(
  ctx: VoiceScreenToolContext,
  name: string,
  args: Record<string, unknown> | null
): Promise<VoiceToolResult> {
  switch (name) {
    case DESCRIBE_SCREEN_TOOL_NAME: {
      const snapshot = await ctx.describeScreen()
      return {
        output: snapshot
          ? formatVoiceScreenSnapshot(snapshot)
          : 'The screen state is not available right now — the window may be busy. Try again in a moment.',
        target: snapshot?.worktreeName ?? undefined,
        transcriptSummary: snapshot
          ? 'Checked the screen overview.'
          : 'Checked the screen overview — it was not available.'
      }
    }
    case SEE_SCREEN_TOOL_NAME: {
      const tree = await ctx.seeScreen()
      return {
        output: tree
          ? `What is on the user's screen right now (refs for click_element / type_into):\n${tree}`
          : SCREEN_UNAVAILABLE,
        transcriptSummary: tree ? 'Read the screen.' : 'Read the screen — it was not available.'
      }
    }
    case READ_TERMINAL_TOOL_NAME: {
      const text = await ctx.readTerminal()
      if (text === null) {
        return {
          output: SCREEN_UNAVAILABLE,
          transcriptSummary: 'Read the terminal — it was not available.'
        }
      }
      return {
        output:
          text.trim().length > 0
            ? `The terminal pane(s) on screen show:\n${text}`
            : 'No terminal pane is visible on screen right now — the user may be on another view or tab.',
        transcriptSummary:
          text.trim().length > 0 ? 'Read the terminal.' : 'Read the terminal — no pane visible.'
      }
    }
    case CLICK_ELEMENT_TOOL_NAME: {
      const ref = readStringArg(args, 'ref')
      if (!ref) {
        return {
          output: 'The click_element call was missing the ref; call see_screen for fresh refs.'
        }
      }
      return uiActionResult(await ctx.performUiAction({ kind: 'click', ref }), 'click')
    }
    case TYPE_INTO_TOOL_NAME: {
      const ref = readStringArg(args, 'ref')
      const text = readStringArg(args, 'text')
      if (!ref) {
        return {
          output: 'The type_into call was missing the ref; call see_screen for fresh refs.'
        }
      }
      if (!text) {
        return { output: 'The type_into call needs the text as well; ask the user to repeat it.' }
      }
      return uiActionResult(await ctx.performUiAction({ kind: 'type', ref, text }), 'type')
    }
    default:
      return { output: `Unknown screen tool: ${name}` }
  }
}

/**
 * click_element / type_into share their result shape: a fresh tree on success (the model
 * answers from it, and stale refs die with the old snapshot), an honest reason otherwise.
 */
function uiActionResult(
  result: VoiceUiActionResult | null,
  action: 'click' | 'type'
): VoiceToolResult {
  const past = action === 'click' ? 'clicked' : 'typed into'
  if (!result) {
    return {
      output: SCREEN_UNAVAILABLE,
      transcriptSummary: `Tried to ${action === 'click' ? 'click' : 'type into'} an element — the screen was not available.`
    }
  }
  if (!result.ok) {
    return {
      output: `That did not work: ${result.error}`,
      transcriptSummary: `Tried to ${action === 'click' ? 'click' : 'type into'} an element — ${result.error}`
    }
  }
  return {
    output: `Done — ${past} "${result.elementName}". The screen now:\n${result.tree}`,
    target: result.elementName,
    transcriptSummary:
      action === 'click'
        ? `Clicked "${result.elementName}".`
        : `Typed into "${result.elementName}".`
  }
}
