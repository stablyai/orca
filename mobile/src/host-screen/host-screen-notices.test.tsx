import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { HostScreenNotices } from './host-screen-notices'

type DiagnosticsProps = { onPress: () => void }
type NoticeProps = { message: string; onDismiss: () => void }

vi.mock('react-native', () => ({
  Text: 'span',
  View: 'div',
  Pressable: 'button',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('../components/AutoHeight', () => ({
  Presence: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../components/HostDiagnosticsLink', () => ({
  HostDiagnosticsLink: (props: DiagnosticsProps) => createElement('Diagnostics', props)
}))
vi.mock('../components/HostRouteNoticeBanner', () => ({
  HostRouteNoticeBanner: (props: NoticeProps) => createElement('aside', props)
}))

it('keeps retry and re-pair actions available when the host rejects authentication', async () => {
  const retried: string[] = []
  const routes: unknown[] = []
  let remove = false
  const controller = {
    connState: 'auth-failed' as const,
    hostId: 'host-1',
    reconnectAttempts: 0,
    relayRecovery: { pairingRejected: false },
    forceReconnectHost: (hostId: string) => {
      retried.push(hostId)
      return Promise.resolve()
    },
    router: {
      push: (route: unknown) => {
        routes.push(route)
      }
    },
    routeNotice: null,
    noticeParam: undefined,
    setDismissedNotice: () => {},
    state: {
      serverNotice: null,
      actionError: '',
      setServerNotice: () => {},
      setActionError: () => {},
      setConfirmRemoveHost: (value: unknown) => {
        remove = value === true
      }
    }
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(HostScreenNotices, { controller }))
  })
  const actions = tree.root.findAllByType('button')
  expect(actions).toHaveLength(3)
  await act(async () => {
    actions[0].props.onPress()
    actions[1].props.onPress()
    actions[2].props.onPress()
  })
  expect(retried).toEqual(['host-1'])
  expect(routes).toEqual(['/pair-scan'])
  expect(remove).toBe(true)
  await act(async () => tree.unmount())
})

it('keeps workspace-return reasons and action errors dismissible in either host view', async () => {
  const dismissed: unknown[] = []
  const controller = {
    connState: 'connected' as const,
    hostId: 'host-1',
    reconnectAttempts: 0,
    relayRecovery: { pairingRejected: false },
    forceReconnectHost: null,
    router: { push: () => {} },
    routeNotice: 'The workspace is no longer available.',
    noticeParam: 'workspace-missing',
    setDismissedNotice: (value: unknown) => {
      dismissed.push(value)
    },
    state: {
      serverNotice: 'Update the paired server.',
      actionError: 'The action failed.',
      setServerNotice: (value: unknown) => {
        dismissed.push(value)
      },
      setActionError: (value: unknown) => {
        dismissed.push(value)
      },
      setConfirmRemoveHost: () => {}
    }
  }
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(createElement(HostScreenNotices, { controller }))
  })
  const notices = tree.root.findAllByType('aside')
  expect(notices.map((notice) => notice.props.message)).toEqual([
    'The workspace is no longer available.',
    'Update the paired server.',
    'The action failed.'
  ])
  await act(async () => {
    for (const notice of notices) {
      notice.props.onDismiss()
    }
  })
  expect(dismissed).toEqual(['workspace-missing', null, ''])
  await act(async () => tree.unmount())
})
