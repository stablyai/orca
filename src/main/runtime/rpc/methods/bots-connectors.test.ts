import { describe, expect, it, vi } from 'vitest'
import { formatBotConnectors } from '../../../../shared/bots/bot-connectors-view'
import type { RpcContext } from '../core'
import { BOT_CONNECTORS_METHOD } from './bots-connectors'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hostname: () => 'm4-air'
}))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: async () => {
    throw Object.assign(new Error('not logged in'), { code: 4 })
  }
}))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: () => ({ name: 'Ada', github: {}, slack: null, linear: null, google: false })
}))
vi.mock('../../../google/google-connect', () => ({ getGoogleConnect: () => null }))
vi.mock('./connector-act', () => ({
  CONNECTOR_ACT_METHOD: { handler: async () => ({ ok: false, message: 'Not connected.' }) }
}))

async function gitHubLine(servesWithoutWindow: boolean): Promise<string | undefined> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only these runtime members.
  const context = {
    caller: { kind: 'desktop' },
    runtime: {
      bots: { assertEnabled: () => {} },
      linearStatus: async () => ({ connected: true }),
      servesWithoutWindow: () => servesWithoutWindow
    }
  } as unknown as RpcContext
  const view = await BOT_CONNECTORS_METHOD.handler({ callerSessionId: 'chat-1' }, context)
  return formatBotConnectors(view).split('\n')[0]
}

describe('orca bot connectors', () => {
  it('names the computer gh is signed out on, unless it is the one with Orca open', async () => {
    expect(await gitHubLine(true)).toBe(
      'GitHub: `gh`, as your owner. gh is signed out on m4-air. Ask your owner to run `gh auth login` on m4-air.'
    )
    expect(await gitHubLine(false)).toBe(
      'GitHub: `gh`, as your owner. gh is signed out on this computer. Ask your owner to run `gh auth login` here.'
    )
  })
})
