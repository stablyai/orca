import { z } from 'zod'
import { canvasActorSchema, canvasSendSchema } from '../../../../shared/canvas-messaging'
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
    params: canvasActorSchema.extend({ canvasId: z.string().min(1).max(16384) }),
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
    params: z.object({ canvasId: z.string().min(1).max(16384) }),
    handler: (params, { runtime }) => ({
      messages: getCanvasMessaging(runtime).journal.history(params.canvasId)
    })
  })
]
