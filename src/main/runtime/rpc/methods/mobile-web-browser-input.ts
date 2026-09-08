import { z } from 'zod'
import { defineMethod } from '../core'
import {
  mobileWebBrowserTargetFields,
  MOBILE_WEB_BROWSER_APPLIED,
  MobileWebBrowserCoordinate,
  MobileWebBrowserTarget
} from './mobile-web-browser-target'

const PointerParams = z.discriminatedUnion('action', [
  MobileWebBrowserTarget.extend({
    action: z.literal('scroll'),
    x: MobileWebBrowserCoordinate,
    y: MobileWebBrowserCoordinate,
    dx: MobileWebBrowserCoordinate,
    dy: MobileWebBrowserCoordinate
  }),
  MobileWebBrowserTarget.extend({
    action: z.literal('click'),
    x: MobileWebBrowserCoordinate,
    y: MobileWebBrowserCoordinate,
    button: z.enum(['left', 'right']),
    modifiers: z.array(z.enum(['cmd', 'ctrl', 'alt', 'shift'])).max(4),
    radius: z.number().finite().min(0).max(1000).optional()
  })
])

const KeyboardParams = z.discriminatedUnion('action', [
  MobileWebBrowserTarget.extend({
    action: z.literal('insertText'),
    text: z
      .string()
      .min(1)
      .max(32 * 1024)
  }),
  MobileWebBrowserTarget.extend({
    action: z.literal('keypress'),
    key: z.enum(['Enter', 'Backspace', 'Tab', 'Escape'])
  })
])

export const MOBILE_WEB_BROWSER_INPUT_METHODS = [
  defineMethod({
    name: 'mobileWeb.browser.pointer',
    params: PointerParams,
    handler: async (params, context) => {
      const target = mobileWebBrowserTargetFields(params)
      if (params.action === 'scroll') {
        await context.runtime.browserMouseMove({ ...target, x: params.x, y: params.y })
        await context.runtime.browserMouseWheel({ ...target, dx: params.dx, dy: params.dy })
        return MOBILE_WEB_BROWSER_APPLIED
      }
      await context.runtime.browserMouseClick({
        ...target,
        x: params.x,
        y: params.y,
        button: params.button,
        modifiers: params.modifiers,
        ...(params.radius === undefined ? {} : { radius: params.radius })
      })
      return MOBILE_WEB_BROWSER_APPLIED
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.keyboard',
    params: KeyboardParams,
    handler: async (params, context) => {
      const target = mobileWebBrowserTargetFields(params)
      await (params.action === 'insertText'
        ? context.runtime.browserKeyboardInsertText({ ...target, text: params.text })
        : context.runtime.browserKeypress({ ...target, key: params.key }))
      return MOBILE_WEB_BROWSER_APPLIED
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.dialog',
    params: MobileWebBrowserTarget.extend({ action: z.enum(['accept', 'dismiss']) }),
    handler: async (params, context) => {
      const target = mobileWebBrowserTargetFields(params)
      await (params.action === 'accept'
        ? context.runtime.browserDialogAccept(target)
        : context.runtime.browserDialogDismiss(target))
      return MOBILE_WEB_BROWSER_APPLIED
    }
  })
]
