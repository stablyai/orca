import type { WebContents } from 'electron'
import type { z } from 'zod'
import { PluginCliError } from '../../../shared/plugins/approval/plugin-cli-approval'
import { parsePluginDeclarativeTree } from '../../../shared/plugins/declarative/plugin-declarative-tree'
import type { PluginShotReplayParams } from '../../../shared/rpc-contract/plugins-params'
import { capturePluginPanelPng, withPaintingWhileHidden } from './plugin-view-capture'
import { requestPluginViewFromRenderer } from './plugin-view-renderer-relay'
import { pluginShotReplayRefusal } from './plugin-shot-policy'
import type { PluginShotResult } from './plugin-view-desktop'

export type PluginShotReplayResult = PluginShotResult & { replay: true; scenario: string }

export type PluginShotReplayDeps = {
  /** The main window's renderer, never a plugin guest. */
  contents: WebContents
  windowShown: boolean
}

const DRAW_TIMEOUT_MS = 5_000
const REPLY_GRACE_MS = 5_000
const END_TIMEOUT_MS = 10_000

/**
 * Draws a tree the CLI rendered from a `.check.ts` scenario in a detached preview and captures it.
 * Why no plugin lookup: the scenario's data must never reach the plugin's panel, guest or worker.
 */
export async function shootPluginReplay(
  deps: PluginShotReplayDeps,
  params: z.infer<typeof PluginShotReplayParams>
): Promise<PluginShotReplayResult> {
  const parsed = parsePluginDeclarativeTree(params.tree)
  if (!parsed.ok) {
    throw new PluginCliError(
      'invalid_argument',
      `The scenario's tree is invalid: ${parsed.error}`,
      {
        reason: 'invalid_tree',
        nextSteps: ['`orca plugin check` shows what the panel draws and why Orca refuses it.']
      }
    )
  }
  const refusal = pluginShotReplayRefusal(deps.windowShown)
  if (refusal) {
    throw new PluginCliError('invalid_argument', refusal.message, {
      reason: refusal.reason,
      nextSteps: refusal.nextSteps
    })
  }
  const { contents } = deps
  return withPaintingWhileHidden([contents], async () => {
    try {
      const reply = await requestPluginViewFromRenderer(
        contents,
        {
          kind: 'replay-panel',
          replay: {
            tree: parsed.tree,
            ...(params.width === undefined ? {} : { width: params.width }),
            ...(params.colorScheme === undefined ? {} : { colorScheme: params.colorScheme }),
            timeoutMs: DRAW_TIMEOUT_MS
          }
        },
        DRAW_TIMEOUT_MS + REPLY_GRACE_MS
      )
      if (!reply.ok) {
        throw new PluginCliError('invalid_argument', reply.message, {
          reason: reply.code,
          nextSteps: []
        })
      }
      if (!reply.panel) {
        throw new Error('Orca did not report where the preview is drawn.')
      }
      const drawn = reply.panel
      const image = await capturePluginPanelPng(contents, drawn.rect)
      return {
        pluginKey: params.pluginKey,
        panelId: params.panelId,
        title: params.title ?? params.panelId,
        ui: 'components',
        png: image.png.toString('base64'),
        width: image.width,
        height: image.height,
        colorScheme: drawn.colorScheme,
        themeApplied: drawn.themeApplied,
        settled: drawn.settled,
        errors: drawn.issue ? [drawn.issue] : [],
        replay: true,
        scenario: params.scenario
      }
    } finally {
      await requestPluginViewFromRenderer(contents, { kind: 'end-capture' }, END_TIMEOUT_MS).catch(
        () => null
      )
    }
  })
}
