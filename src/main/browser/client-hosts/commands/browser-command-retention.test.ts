import { expect, it } from 'vitest'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserHostCommandResultCache } from '../../../runtime/browser-host/commands/browser-host-command-result-cache'
import {
  createBrowserHostCommandPageState,
  createBrowserHostCommandRecord,
  resolveBrowserHostCommandCacheLimits
} from '../../../runtime/browser-host/commands/browser-host-command-state'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'
import { BrowserClientHostCommandResultCache } from './browser-client-host-command-result-cache'
import {
  createCommandRecord,
  createPageState,
  resolveDispatcherLimits
} from './browser-client-host-command-state'

const authority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  pageCommandProtocolVersion: 1 as const
}
const raw = 'https://kagi.com/search?token=retained-secret&q=one'
const safe = 'https://kagi.com/search?q=one'
const ordinary = 'https://example.com/search?token=ordinary&q=one'

function event(
  command: BrowserClientHostCommandEvent['command'],
  commandSequence = 1
): BrowserClientHostCommandEvent {
  return {
    ...authority,
    type: 'command',
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    commandSequence,
    commandId: `command-${commandSequence}`,
    command
  }
}

for (const cache of ['host', 'client'] as const) {
  for (const status of ['completed', 'failed'] as const) {
    it(`removes private navigation operands from the ${status} ${cache} command cache`, () => {
      for (const [url, expected] of [
        [raw, safe],
        [ordinary, ordinary]
      ]) {
        const commands: BrowserClientHostCommandEvent['command'][] = [
          {
            type: 'createPage',
            browserProfileId: 'default',
            executionHostKey: 'host',
            initialUrl: url
          },
          { type: 'navigate', url },
          { type: 'restorePage', browserProfileId: 'default', executionHostKey: 'host', url },
          { type: 'automation', method: 'browser.goto', params: { url, expectUrl: url } },
          { type: 'automation', method: 'browser.reload', params: { expectUrl: url } }
        ]
        for (const command of commands) {
          const input = event(command)
          const result =
            status === 'completed' ? { status } : { status, errorCode: 'controlled-failure' }
          const hostRecord = createBrowserHostCommandRecord(input, 'placed-page')
          hostRecord.settled = result
          const hostPage = createBrowserHostCommandPageState(1)
          const hostCache = new BrowserHostCommandResultCache(
            resolveBrowserHostCommandCacheLimits({ authority }),
            () => {}
          )
          hostCache.remember(hostPage, hostRecord)
          const clientRecord = createCommandRecord(input)
          clientRecord.status = 'settled'
          clientRecord.result = result
          const clientCache = new BrowserClientHostCommandResultCache(
            resolveDispatcherLimits({ authority, handler: () => result })
          )
          clientCache.record(createPageState('page-a', 1), clientRecord)

          const expectedCommand =
            command.type === 'createPage'
              ? { ...command, initialUrl: expected }
              : command.type === 'automation'
                ? {
                    ...command,
                    params:
                      command.method === 'browser.goto'
                        ? { url: expected, expectUrl: expected }
                        : { expectUrl: expected }
                  }
                : { ...command, url: expected }
          const retainedRecord = cache === 'host' ? hostRecord : clientRecord
          expect(retainedRecord.event.command).toEqual(expectedCommand)
          expect(input.command).toEqual(command)
          expect(JSON.stringify([hostRecord.event, clientRecord])).not.toContain('retained-secret')
        }
      }
    })
  }
}

it('replays private commands exactly after retention without accepting a different bearer', async () => {
  const delivered: BrowserClientHostCommandEvent['command'][] = []
  const dispatcher = new BrowserClientHostCommandDispatcher({
    authority,
    handler: (input) => {
      delivered.push(input.command)
      return { status: 'completed' }
    }
  })
  const created = event({
    type: 'createPage',
    browserProfileId: 'default',
    executionHostKey: 'host',
    initialUrl: raw
  })
  const navigated = event({ type: 'navigate', url: raw }, 2)
  try {
    for (const input of [created, navigated]) {
      await expect(dispatcher.dispatch(input)).resolves.toEqual({ status: 'completed' })
      await expect(dispatcher.dispatch(input)).resolves.toEqual({ status: 'completed' })
      const changed =
        input.command.type === 'createPage'
          ? { ...input.command, initialUrl: 'https://kagi.com/search?token=different&q=one' }
          : { type: 'navigate' as const, url: 'https://kagi.com/search?token=different&q=one' }
      expect(() => dispatcher.dispatch({ ...input, command: changed })).toThrow(
        'browser_host_command_sequence_conflict'
      )
      expect(() => dispatcher.dispatch({ ...input, authorityEpoch: 'stale' })).toThrow(
        'browser_host_command_authority_stale'
      )
    }
    expect(delivered).toEqual([
      {
        type: 'createPage',
        browserProfileId: 'default',
        executionHostKey: 'host',
        initialUrl: raw
      },
      { type: 'navigate', url: raw }
    ])
  } finally {
    await dispatcher.close()
  }
})
