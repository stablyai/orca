import { describe, expect, it } from 'vitest'
import { readBridgeNativeVerbCall } from './bridge-native-verbs'

const request = {
  worktreeId: 'wt-1',
  agent: 'claude',
  surface: 'chat',
  usageLimited: false,
  canCopy: true,
  canExport: true,
  canNewWorktree: true,
  canSubagent: false,
  capabilities: ['aiVault.chatFork.export'],
  preset: null,
  forkFrom: { sessionId: 'session-1', throughItemId: 'item-9' },
  recaps: { history: 'Recap of the whole chat', current: null }
}

function read(params: unknown, granted: readonly string[] = ['native.chat.fork']) {
  return readBridgeNativeVerbCall({ method: 'native.chat.fork', granted, params })
}

describe('the served page asking the app to fork its chat', () => {
  it('is served when the route grants it', () => {
    expect(read(request)).toEqual({ ok: true, verb: 'native.chat.fork', params: request })
  })

  it('refuses a page that names the source host, an unknown agent, or an oversized recap', () => {
    // The shell forks from the host it serves the page for, never one the page names.
    expect(read({ ...request, hostId: 'other-host' })).toMatchObject({ refusal: 'invalid-params' })
    expect(read({ ...request, agent: 'not-an-agent' })).toMatchObject({
      refusal: 'invalid-params'
    })
    expect(
      read({ ...request, recaps: { history: 'x'.repeat(64_001), current: null } })
    ).toMatchObject({ refusal: 'invalid-params' })
  })

  it('is refused on a route that was not granted it', () => {
    expect(read(request, [])).toMatchObject({ ok: false, refusal: 'ungranted' })
  })
})
