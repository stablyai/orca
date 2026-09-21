import {
  canvasActorSchema,
  canvasSendSchema,
  canvasInboxSchema,
  canvasHistorySchema
} from '../../../../shared/canvas-messaging'
import { getCanvasMessaging } from '../../canvas/canvas-messaging-runtime'
import { defineMethod } from '../core'

export const CANVAS_MESSAGING_METHODS = [
  defineMethod({
    name: 'canvas.peers',
    params: canvasActorSchema,
    handler: (params, { runtime }) => ({
      canvases: getCanvasMessaging(runtime).peers(params.paneKey, params.launchToken)
    })
  }),
  defineMethod({
    name: 'canvas.send',
    params: canvasSendSchema,
    handler: (params, { runtime }) => ({ message: getCanvasMessaging(runtime).send(params) })
  }),
  defineMethod({
    name: 'canvas.inbox',
    params: canvasInboxSchema,
    handler: (params, { runtime }) => ({
      messages: getCanvasMessaging(runtime).inbox(
        params.canvasId,
        params.paneKey,
        params.launchToken
      )
    })
  }),
  defineMethod({
    name: 'canvas.history',
    params: canvasHistorySchema,
    // Owner-scoped, not agent-scoped: the renderer's history view needs reads after every
    // agent has disconnected, and agents have no `canvas history` CLI path to this method.
    // Transport auth admits only the paired runtime owner (mobile scope is forbidden; see
    // canvas-history-authorization.test.ts). Agent reads stay membership-checked in `canvas.inbox`.
    handler: (params, { runtime }) => ({
      messages: getCanvasMessaging(runtime).journal.history(params.canvasId)
    })
  })
]
