import { createHash } from 'node:crypto'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { redactKagiSessionToken } from '../../../../shared/browser/navigation/browser-url'

type Command = BrowserClientHostCommandEvent['command']

export function browserCommandUrlDigest(command: Command): string | undefined {
  const url =
    command.type === 'createPage'
      ? command.initialUrl
      : command.type === 'navigate' || command.type === 'restorePage'
        ? command.url
        : undefined
  return url === undefined ? undefined : createHash('sha256').update(url, 'utf16le').digest('hex')
}

export function retainBrowserCommandEvent(event: BrowserClientHostCommandEvent): {
  event: BrowserClientHostCommandEvent
  urlDigest?: string
} {
  const command = event.command
  let retained = command
  if (command.type === 'createPage' && command.initialUrl !== undefined) {
    const initialUrl = redactKagiSessionToken(command.initialUrl)
    if (initialUrl !== command.initialUrl) {
      retained = { ...command, initialUrl }
    }
  } else if (
    (command.type === 'navigate' || command.type === 'restorePage') &&
    command.url !== undefined
  ) {
    const url = redactKagiSessionToken(command.url)
    if (url !== command.url) {
      retained = { ...command, url }
    }
  } else if (command.type === 'automation') {
    let params = command.params
    for (const field of command.method === 'browser.goto' ? ['url', 'expectUrl'] : ['expectUrl']) {
      const raw = params[field]
      if (typeof raw !== 'string') {
        continue
      }
      const safe = redactKagiSessionToken(raw)
      if (safe !== raw) {
        params = { ...params, [field]: safe }
      }
    }
    if (params !== command.params) {
      retained = { ...command, params: Object.freeze(params) }
    }
  }
  return retained === command
    ? { event }
    : {
        event: Object.freeze({ ...event, command: Object.freeze(retained) }),
        urlDigest: browserCommandUrlDigest(command)
      }
}
