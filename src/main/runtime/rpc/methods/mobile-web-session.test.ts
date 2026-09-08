import { describe, expect, it } from 'vitest'
import { MobileWebSessionSnapshotResultSchema } from '../../../../shared/mobile-web/session-operation-contract'
import { MOBILE_WEB_SESSION_METHODS } from './mobile-web-session'
import { sessionFixture } from './mobile-web-session-test-fixture'

const [snapshot, activate, close] = MOBILE_WEB_SESSION_METHODS

describe('host-owned session snapshots and actions', () => {
  it('addresses chat by the provider session id while hiding host terminal handles', async () => {
    const f = sessionFixture()
    const first = await snapshot.handler(f.params, f.context)
    expect(await snapshot.handler(f.params, f.context)).toEqual(first)
    expect(first).toMatchObject({
      workspaceId: 'opaque-workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1
    })
    const tab = MobileWebSessionSnapshotResultSchema.parse(first).tabs[0]
    expect(tab).toMatchObject({ type: 'terminal', nativeChatSessionId: 'provider-session' })
    expect(JSON.stringify(first)).not.toContain('private-terminal')
    expect(JSON.stringify(first)).not.toContain('/private/transcript')
    expect(f.runtime.listMobileSessionTabs).toHaveBeenCalledWith(f.params.worktree, 'device')
  })

  it('refuses a snapshot published for a different workspace', async () => {
    const f = sessionFixture()
    f.setSnapshot({ ...f.snapshot, worktree: 'folder:other' })
    await expect(snapshot.handler(f.params, f.context)).rejects.toThrow('selector_not_found')
  })

  it('uses original activation and close handlers with caller navigation and no ambiguous-result retry', async () => {
    const f = sessionFixture()
    await activate.handler({ ...f.params, tabId: 'tab' }, f.context)
    expect(f.runtime.activateMobileSessionTab).toHaveBeenCalledWith(
      f.params.worktree,
      'tab',
      undefined,
      expect.objectContaining({
        notifyClients: false,
        navigation: 'caller',
        clientNavigationId: 'device'
      })
    )
    expect(await close.handler({ ...f.params, tabId: 'tab' }, f.context)).toMatchObject({
      outcome: 'closed',
      tabId: 'tab'
    })
    f.runtime.closeMobileSessionTab.mockRejectedValueOnce(new Error('lost acknowledgement'))
    await expect(close.handler({ ...f.params, tabId: 'tab' }, f.context)).rejects.toThrow(
      'lost acknowledgement'
    )
    expect(f.runtime.closeMobileSessionTab).toHaveBeenCalledTimes(2)
  })

  it('passes a browser page id straight through to the host tab handlers', async () => {
    const f = sessionFixture()
    await activate.handler({ ...f.params, tabId: 'host-browser-page' }, f.context)
    expect(f.runtime.activateMobileSessionTab).toHaveBeenCalledWith(
      f.params.worktree,
      'host-browser-page',
      undefined,
      expect.anything()
    )
  })
})
