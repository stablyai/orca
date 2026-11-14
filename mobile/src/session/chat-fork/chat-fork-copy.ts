import { translate } from '../../i18n/mobile-i18n'

/** The fork sheet's toasts and progress lines. */
export const chatForkCopy = {
  copying: (host: string, percent: number) =>
    translate('chat.fork.sheet.copying', 'Copying the chat to {{host}}… {{percent}}%', {
      host,
      percent: String(percent)
    }),
  opening: (host: string) =>
    translate('chat.fork.sheet.opening', 'Opening the fork on {{host}}…', { host }),
  offline: (host: string) =>
    translate(
      'chat.fork.sheet.offline',
      '{{host}} isn’t connected. Connect to it, then fork again.',
      {
        host
      }
    ),
  notNow: () =>
    translate(
      'chat.fork.sheet.notNow',
      'This response can’t be forked right now. Wait for the chat to finish, then try again.'
    ),
  noRecap: () =>
    translate(
      'chat.fork.sheet.noRecap',
      'There’s nothing in this chat yet to hand to another agent.'
    ),
  tooLarge: () =>
    translate(
      'chat.fork.sheet.tooLarge',
      'This chat is too large to copy to another host. Fork it with another agent instead.'
    ),
  busy: (host: string) =>
    translate(
      'chat.fork.sheet.busy',
      '{{host}} is copying other chats. Wait a moment, then fork again.',
      { host }
    ),
  targetUnsupported: () =>
    translate(
      'chat.fork.sheet.targetUnsupported',
      'That workspace can’t take a copied chat. Pick a local workspace on that host.'
    ),
  sourceUnavailable: () =>
    translate(
      'chat.fork.sheet.sourceUnavailable',
      'This chat’s saved history wasn’t found on this host, so it can’t be copied.'
    ),
  relayFailed: (host: string, detail: string) =>
    translate('chat.fork.sheet.relayFailed', 'Couldn’t copy the chat to {{host}}. {{detail}}', {
      host,
      detail
    }),
  unconfirmed: (agent: string) =>
    translate(
      'chat.fork.unconfirmed',
      "{{agent}} couldn't confirm the fork. It may have opened anyway; check Session History before forking again.",
      { agent }
    ),
  failed: (agent: string, detail: string) =>
    translate('chat.fork.failed', "{{agent}} couldn't fork this chat. {{detail}}", {
      agent,
      detail
    }),
  unsupported: () =>
    translate(
      'chat.fork.unsupported',
      'This host runs an older Orca. Update Orca on the host, then try again.'
    )
}
