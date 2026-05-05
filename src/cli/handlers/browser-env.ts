import type { BrowserGeolocationResult, BrowserViewportResult } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalStringFlag,
  getRequiredFiniteNumber,
  getRequiredPositiveNumber,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserCommandTarget } from '../selectors'

export const BROWSER_ENV_HANDLERS: Record<string, CommandHandler> = {
  viewport: async ({ flags, client, cwd, json }) => {
    const width = getRequiredPositiveNumber(flags, 'width')
    const height = getRequiredPositiveNumber(flags, 'height')
    const params: Record<string, unknown> = { width, height }
    const scale = getOptionalStringFlag(flags, 'scale')
    if (scale) {
      const n = Number(scale)
      if (!Number.isFinite(n) || n <= 0) {
        throw new RuntimeClientError('invalid_argument', '--scale must be a positive number')
      }
      params.deviceScaleFactor = n
    }
    if (flags.has('mobile')) {
      params.mobile = true
    }
    Object.assign(params, await getBrowserCommandTarget(flags, cwd, client))
    const result = await client.call<BrowserViewportResult>('browser.viewport', params)
    printResult(
      result,
      json,
      (v) => `Viewport set to ${v.width}×${v.height}${v.mobile ? ' (mobile)' : ''}`
    )
  },
  geolocation: async ({ flags, client, cwd, json }) => {
    const latitude = getRequiredFiniteNumber(flags, 'latitude')
    const longitude = getRequiredFiniteNumber(flags, 'longitude')
    const params: Record<string, unknown> = { latitude, longitude }
    const accuracy = getOptionalStringFlag(flags, 'accuracy')
    if (accuracy) {
      const n = Number(accuracy)
      if (!Number.isFinite(n) || n <= 0) {
        throw new RuntimeClientError('invalid_argument', '--accuracy must be a positive number')
      }
      params.accuracy = n
    }
    Object.assign(params, await getBrowserCommandTarget(flags, cwd, client))
    const result = await client.call<BrowserGeolocationResult>('browser.geolocation', params)
    printResult(result, json, (v) => `Geolocation set to ${v.latitude}, ${v.longitude}`)
  },
  'set device': async ({ flags, client, cwd, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.setDevice', { name, ...target })
    printResult(result, json, () => `Device emulation set to ${name}`)
  },
  'set offline': async ({ flags, client, cwd, json }) => {
    const state = getOptionalStringFlag(flags, 'state')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.setOffline', { state, ...target })
    printResult(result, json, () => `Offline mode ${state ?? 'toggled'}`)
  },
  'set headers': async ({ flags, client, cwd, json }) => {
    const headers = getRequiredStringFlag(flags, 'headers')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.setHeaders', { headers, ...target })
    printResult(result, json, () => 'Extra HTTP headers set')
  },
  'set credentials': async ({ flags, client, cwd, json }) => {
    const user = getRequiredStringFlag(flags, 'user')
    const pass = getRequiredStringFlag(flags, 'pass')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.setCredentials', {
      user,
      pass,
      ...target
    })
    printResult(result, json, () => `HTTP auth credentials set for ${user}`)
  },
  'set media': async ({ flags, client, cwd, json }) => {
    const colorScheme = getOptionalStringFlag(flags, 'color-scheme')
    const reducedMotion = getOptionalStringFlag(flags, 'reduced-motion')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.setMedia', {
      colorScheme,
      reducedMotion,
      ...target
    })
    printResult(result, json, () => 'Media preferences set')
  },
  'clipboard read': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.clipboardRead', target)
    printResult(result, json, (v) => JSON.stringify(v, null, 2))
  },
  'clipboard write': async ({ flags, client, cwd, json }) => {
    const text = getRequiredStringFlag(flags, 'text')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.clipboardWrite', { text, ...target })
    printResult(result, json, () => 'Clipboard updated')
  },
  'dialog accept': async ({ flags, client, cwd, json }) => {
    const text = getOptionalStringFlag(flags, 'text')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.dialogAccept', { text, ...target })
    printResult(result, json, () => 'Dialog accepted')
  },
  'dialog dismiss': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.dialogDismiss', target)
    printResult(result, json, () => 'Dialog dismissed')
  }
}
