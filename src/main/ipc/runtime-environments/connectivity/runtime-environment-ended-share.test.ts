// A window's call, status read or Connect to a share its owner ended answers as ended: the share is
// asked before the host is resolved, as it no longer resolves.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SHARED_BOT_HOST_ERRORS } from '../../../../shared/bots/shared-bot-hosts'
import { sharedBotUnshared } from '../../../bots/shared-with-me/shared-bot-host-answers'
import { setSharedHostsOwner } from '../requests/runtime-environment-shared-hosts'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

const {
  registerRuntimeEnvironmentConnectivityHandlers,
  registerRuntimeEnvironmentPassiveHandlers
} = await import('./runtime-environment-connectivity-handlers')

const userDataPath = mkdtempSync(join(tmpdir(), 'ended-share-'))
afterEach(() => setSharedHostsOwner(null))

it('answers a call, status read or Connect to an ended share as ended, never an unknown server', async () => {
  const ended = (selector: string, method: string) =>
    Promise.resolve(selector === 'env-ended' ? sharedBotUnshared(method) : null)
  setSharedHostsOwner({
    ready: async () => {},
    settled: async () => {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no phone asks in this test.
    phones: null as never,
    answerHere: ended,
    endedAnswer: ended
  })
  registerRuntimeEnvironmentPassiveHandlers(() => userDataPath)
  registerRuntimeEnvironmentConnectivityHandlers({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these channels read no store before the share answers.
    store: {} as never,
    getUserDataPath: () => userDataPath,
    invalidateTransport: () => {}
  })
  const unshared = { ok: false, error: { code: SHARED_BOT_HOST_ERRORS.unshared } }
  for (const [channel, args] of [
    ['runtimeEnvironments:call', { selector: 'env-ended', method: 'bots.list' }],
    ['runtimeEnvironments:getStatus', { selector: 'env-ended' }],
    ['runtimeEnvironments:connect', { selector: 'env-ended' }]
  ] as const) {
    expect(await handlers.get(channel)!({}, args), channel).toMatchObject(unshared)
  }
  // Any other host still resolves as a paired server.
  await expect(
    handlers.get('runtimeEnvironments:call')!({}, { selector: 'env-unknown', method: 'bots.list' })
  ).rejects.toThrow('Unknown environment')
  rmSync(userDataPath, { recursive: true, force: true })
})
