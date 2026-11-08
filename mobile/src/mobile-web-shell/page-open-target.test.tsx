import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { usePageOpenTarget } from './page-open-target'

const HOST = { pathname: '/h/host-1' }
const SESSION = '/h/host-1/session/wt-1'

type Args = Parameters<typeof usePageOpenTarget>[0]
const rendered: { tree?: ReactTestRenderer; view?: ReturnType<typeof usePageOpenTarget> } = {}

function Probe(props: { args: Args }) {
  rendered.view = usePageOpenTarget(props.args)
  return null
}

async function show(args: Args): Promise<void> {
  await act(async () => {
    if (rendered.tree === undefined) {
      rendered.tree = create(createElement(Probe, { args }))
    } else {
      rendered.tree.update(createElement(Probe, { args }))
    }
  })
}

afterEach(() => {
  act(() => rendered.tree?.unmount())
  rendered.tree = undefined
})

function shellArgs(overrides: Partial<Args>): Args {
  return {
    route: HOST,
    sessionId: 'doc-1',
    pageVersion: 3,
    isFocused: () => true,
    openNatively: vi.fn(),
    ...overrides
  }
}

it('reopens the session a lost document showed in the document that replaces it', async () => {
  await show(shellArgs({}))
  await act(async () => rendered.view?.recordLocation(SESSION))
  await show(shellArgs({ sessionId: 'doc-2' }))

  expect(rendered.view?.pageRoute).toEqual({ pathname: '/h/host-1', params: { open: SESSION } })

  await act(async () => rendered.view?.onRouteParamClear('open', SESSION))
  expect(rendered.view?.pageRoute).toEqual({ pathname: '/h/host-1' })
})

it('lets a session tapped while the document came back replace the place it restores', async () => {
  const TAPPED = '/h/host-1/session/wt-2'
  await show(shellArgs({}))
  await act(async () => rendered.view?.recordLocation(SESSION))
  await show(shellArgs({ sessionId: 'doc-2', route: { ...HOST, params: { open: TAPPED } } }))
  expect(rendered.view?.pageRoute).toEqual({ pathname: '/h/host-1', params: { open: TAPPED } })

  await act(async () => rendered.view?.onRouteParamClear('open', TAPPED))
  await show(shellArgs({ sessionId: 'doc-2' }))
  expect(rendered.view?.pageRoute).toEqual({ pathname: '/h/host-1' })
})
