import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getRequiredStringFlag } from '../flags'
import { getBrowserCommandTarget } from '../selectors'

export const BROWSER_STORAGE_HANDLERS: Record<string, CommandHandler> = {
  'storage local get': async ({ flags, client, cwd, json }) => {
    const key = getRequiredStringFlag(flags, 'key')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.storage.local.get', { key, ...target })
    printResult(result, json, (v) => JSON.stringify(v, null, 2))
  },
  'storage local set': async ({ flags, client, cwd, json }) => {
    const key = getRequiredStringFlag(flags, 'key')
    const value = getRequiredStringFlag(flags, 'value')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.storage.local.set', {
      key,
      value,
      ...target
    })
    printResult(result, json, () => `localStorage["${key}"] set`)
  },
  'storage local clear': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.storage.local.clear', target)
    printResult(result, json, () => 'localStorage cleared')
  },
  'storage session get': async ({ flags, client, cwd, json }) => {
    const key = getRequiredStringFlag(flags, 'key')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.storage.session.get', { key, ...target })
    printResult(result, json, (v) => JSON.stringify(v, null, 2))
  },
  'storage session set': async ({ flags, client, cwd, json }) => {
    const key = getRequiredStringFlag(flags, 'key')
    const value = getRequiredStringFlag(flags, 'value')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.storage.session.set', {
      key,
      value,
      ...target
    })
    printResult(result, json, () => `sessionStorage["${key}"] set`)
  },
  'storage session clear': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<unknown>('browser.storage.session.clear', target)
    printResult(result, json, () => 'sessionStorage cleared')
  }
}
