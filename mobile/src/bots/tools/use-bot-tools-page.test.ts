import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient
} from '../../mobile-web-shell/test-support/bridge-host-test-fakes'
import { useBotToolsPage } from './use-bot-tools-page'

type Page = ReturnType<typeof useBotToolsPage>

// A command tool: Connectors' 'apps' scope never checks one, so only list reads go out.
const tool = (name: string) => ({ name, detail: `npx ${name}`, remote: false })

describe('useBotToolsPage reread', () => {
  let renderer: ReactTestRenderer | null = null
  let page: Page | null = null

  function Harness({ client }: { client: FakeRpcClient }) {
    page = useBotToolsPage(client, 'bot-1', 'apps')
    return null
  }

  async function answerList(client: FakeRpcClient, index: number, names: string[]) {
    await act(async () => {
      client.requests[index]?.resolve({
        id: `rpc-${index}`,
        ok: true,
        result: { own: names.map(tool), inherited: [] },
        _meta: { runtimeId: 'runtime-1' }
      })
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    page = null
  })

  it('settles a replaced read only once the read that replaced it has landed', async () => {
    const client = createFakeRpcClient()
    await act(async () => {
      renderer = create(createElement(Harness, { client }))
    })
    await answerList(client, 0, ['old-name'])

    // A save rereads, and a route refresh replaces that read before it answers.
    let saveRereadSettled = false
    await act(async () => {
      void page!.reread(true).then(() => {
        saveRereadSettled = true
      })
      void page!.reread()
    })
    expect(client.requests.map((request) => request.method)).toEqual([
      'bots.tools.list',
      'bots.tools.list',
      'bots.tools.list'
    ])

    await answerList(client, 1, ['new-name'])
    expect(saveRereadSettled).toBe(false)

    await answerList(client, 2, ['new-name'])
    expect(saveRereadSettled).toBe(true)
    expect(page!.tools?.own.map((entry) => entry.name)).toEqual(['new-name'])
  })
})

describe('useBotToolsPage Connectors check', () => {
  let renderer: ReactTestRenderer | null = null
  let page: Page | null = null

  function Harness({ client }: { client: FakeRpcClient }) {
    page = useBotToolsPage(client, 'bot-1', 'apps')
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    page = null
  })

  it('checks a list of only apps Orca signed in to, and shows what the check found', async () => {
    const client = createFakeRpcClient()
    await act(async () => {
      renderer = create(createElement(Harness, { client }))
    })
    const signedIn = {
      name: 'notion',
      detail: 'https://mcp.notion.com/mcp',
      remote: false,
      signIn: { state: 'signed-in' }
    }
    await act(async () => {
      client.requests[0]?.resolve({
        id: 'rpc-0',
        ok: true,
        result: { own: [signedIn], inherited: [] },
        _meta: { runtimeId: 'runtime-1' }
      })
    })
    expect(client.requests.map((request) => request.method)).toEqual([
      'bots.tools.list',
      'bots.tools.problems'
    ])
    const failed = { kind: 'failed', detail: 'Your Codex already has a tool named notion' }
    await act(async () => {
      client.requests[1]?.resolve({
        id: 'rpc-1',
        ok: true,
        result: { problems: { notion: failed } },
        _meta: { runtimeId: 'runtime-1' }
      })
    })
    expect(page!.problems).toEqual({ notion: failed })
    // The sign-in itself stays as it is.
    expect(page!.tools?.own[0]).toMatchObject({ signIn: { state: 'signed-in' } })
  })
})
