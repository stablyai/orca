import { expect, it } from 'vitest'
import { sessionScreenIdentity } from '../../session/session-pane-intent'
import { nativeSessionReturn, type NativeStackState } from './native-stack-return'

it('retargets the existing chat and clears its earlier handoff when an ordinary pane opens', () => {
  const state: NativeStackState = {
    key: 'host-stack',
    routes: [
      {
        key: 'chat',
        name: 'h/[hostId]/session/[worktreeId]',
        params: { hostId: 'desk', worktreeId: 'checkout', paneKey: 'old', goalHandoff: 'old-ref' }
      }
    ]
  }
  const href = '/h/desk/session/checkout?paneKey=new&paneIntent=request-2'
  const target = nativeSessionReturn(state, href + '&goalHandoff=new-ref')
  expect(target).toMatchObject({ routeKey: 'chat', params: { goalHandoff: 'new-ref' } })
  expect(nativeSessionReturn(state, href)?.params).toStrictEqual({
    paneKey: 'new',
    paneIntent: 'request-2',
    goalHandoff: undefined,
    botItem: undefined
  })
  expect(
    sessionScreenIdentity({ hostId: 'desk', goalHandoff: 'new-ref', homeDraft: 'hello' })
  ).toEqual({
    hostId: 'desk'
  })
})
