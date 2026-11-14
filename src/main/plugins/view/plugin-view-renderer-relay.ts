import type { WebContents } from 'electron'
import {
  PLUGIN_VIEW_REPLY_CHANNEL,
  PLUGIN_VIEW_REQUEST_CHANNEL,
  type PluginViewReply,
  type PluginViewRequestBody
} from '../../../shared/plugins/view/plugin-view-protocol'
import { RENDERER_UNAVAILABLE, requestFromRenderer } from '../../ipc/renderer-request-relay'
import { pluginViewReplySchema } from './plugin-view-reply-schema'

export const PLUGIN_VIEW_RENDERER_UNAVAILABLE = RENDERER_UNAVAILABLE

const PLUGIN_VIEW_CHANNELS = {
  request: PLUGIN_VIEW_REQUEST_CHANNEL,
  reply: PLUGIN_VIEW_REPLY_CHANNEL,
  parseReply: (raw: unknown): PluginViewReply | null => {
    const parsed = pluginViewReplySchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }
}

/** Sends one view request to the window's renderer and waits for its matching reply. */
export function requestPluginViewFromRenderer(
  webContents: WebContents,
  body: PluginViewRequestBody,
  timeoutMs: number
): Promise<PluginViewReply> {
  return requestFromRenderer(webContents, PLUGIN_VIEW_CHANNELS, body, timeoutMs)
}
