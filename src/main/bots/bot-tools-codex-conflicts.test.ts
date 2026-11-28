import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from '../codex/app-server/codex-app-server-request-error'
import {
  codexLoadedServers,
  codexRefusedThreadServer,
  codexOnlySentServers,
  openWithoutRefusedCodexServers,
  withoutCodexMcpConflicts
} from './bot-tools-codex-conflicts'

const reading = (answer: unknown) => ({
  request: vi.fn(async () => (answer instanceof Error ? Promise.reject(answer) : answer))
})

/** What Codex 0.171 answers a thread whose server has both a command and a URL. */
const refusal = (method: string, name: string) => {
  const text = `failed to load configuration: url is not supported for stdio\nin \`mcp_servers.${name}\``
  return new CodexAppServerRequestError(
    method,
    -32600,
    `codex app-server ${method} failed: ${text}`,
    text
  )
}

describe('withoutCodexMcpConflicts', () => {
  it('asks Codex nothing when the thread adds no server', async () => {
    const rpc = reading({ config: {} })
    const config = { 'mcp_servers.notion.enabled': false, web_search: 'disabled' }
    expect(await withoutCodexMcpConflicts(rpc, '/work', config)).toEqual({
      threadConfig: config,
      leftOut: []
    })
    expect(rpc.request).not.toHaveBeenCalled()
  })

  it('reads the config Codex loads at the thread’s folder', async () => {
    const rpc = reading({ config: { mcp_servers: {} } })
    await withoutCodexMcpConflicts(rpc, '/work', { 'mcp_servers.notion.url': 'https://n/mcp' })
    expect(rpc.request).toHaveBeenCalledWith(
      'config/read',
      { cwd: '/work' },
      { timeoutMs: expect.any(Number) }
    )
  })

  it('drops every key of a server whose kind differs from the loaded one', async () => {
    const rpc = reading({
      config: { mcp_servers: { notion: { command: 'npx', args: [] }, linear: { url: 'u' } } }
    })
    const result = await withoutCodexMcpConflicts(rpc, '/work', {
      'mcp_servers.notion.url': 'https://n/mcp',
      'mcp_servers.notion.http_headers': { authorization: 'Bearer t' },
      'mcp_servers.notionx.url': 'https://x/mcp',
      'mcp_servers.linear.url': 'https://l/mcp',
      web_search: 'disabled'
    })
    expect(result).toEqual({
      threadConfig: {
        'mcp_servers.notionx.url': 'https://x/mcp',
        'mcp_servers.linear.url': 'https://l/mcp',
        web_search: 'disabled'
      },
      leftOut: ['notion']
    })
  })

  it('keeps the thread config as it is when Codex’s config can’t be read', async () => {
    const config = { 'mcp_servers.notion.url': 'https://n/mcp' }
    for (const answer of [new Error('refused'), null, { config: { mcp_servers: 'odd' } }]) {
      expect(await withoutCodexMcpConflicts(reading(answer), '/work', config)).toEqual({
        threadConfig: config,
        leftOut: []
      })
    }
  })
})

describe('codexRefusedThreadServer', () => {
  const config = { 'mcp_servers.notion.url': 'https://n/mcp', web_search: 'live' }

  it('names a server this config adds that Codex refused to open with', () => {
    expect(codexRefusedThreadServer(refusal('thread/start', 'notion'), config)).toBe('notion')
    expect(codexRefusedThreadServer(refusal('thread/resume', 'notion'), config)).toBe('notion')
  })

  it('names nothing for another error, call, or a server the config doesn’t add', () => {
    expect(codexRefusedThreadServer(refusal('thread/start', 'linear'), config)).toBeNull()
    expect(codexRefusedThreadServer(refusal('turn/start', 'notion'), config)).toBeNull()
    expect(codexRefusedThreadServer(new Error('url is not supported for stdio'), config)).toBeNull()
    const other = new CodexAppServerRequestError('thread/start', -32600, 'bad', 'bad')
    expect(codexRefusedThreadServer(other, config)).toBeNull()
  })
})

describe('openWithoutRefusedCodexServers', () => {
  it('opens again without each server Codex refuses, once per server', async () => {
    const config = {
      'mcp_servers.notion.url': 'https://n/mcp',
      'mcp_servers.notion.http_headers': { a: 'b' },
      'mcp_servers.docs.command': 'npx',
      'mcp_servers.linear.url': 'https://l/mcp'
    }
    const open = vi.fn(async (sent: Record<string, unknown> | undefined) => {
      if (sent?.['mcp_servers.notion.url']) {
        throw refusal('thread/start', 'notion')
      }
      if (sent?.['mcp_servers.docs.command']) {
        throw refusal('thread/start', 'docs')
      }
      return 'opened'
    })
    expect(await openWithoutRefusedCodexServers(config, open)).toEqual({
      opened: 'opened',
      leftOut: ['notion', 'docs']
    })
    expect(open).toHaveBeenCalledTimes(3)
    expect(open).toHaveBeenLastCalledWith({ 'mcp_servers.linear.url': 'https://l/mcp' })
  })

  it('keeps a key turning the refused name off', async () => {
    const config = {
      'mcp_servers.notion.url': 'https://n/mcp',
      'mcp_servers.notion.enabled': false
    }
    const open = vi.fn(async (sent: Record<string, unknown> | undefined) => {
      if (sent?.['mcp_servers.notion.url']) {
        throw refusal('thread/start', 'notion')
      }
      return 'opened'
    })
    await openWithoutRefusedCodexServers(config, open)
    expect(open).toHaveBeenLastCalledWith({ 'mcp_servers.notion.enabled': false })
  })

  it('passes any other failure on without opening again', async () => {
    const failure = new Error('spawn failed')
    const open = vi.fn(async () => {
      throw failure
    })
    await expect(
      openWithoutRefusedCodexServers({ 'mcp_servers.notion.url': 'u' }, open)
    ).rejects.toBe(failure)
    const unrelated = refusal('thread/start', 'linear')
    const again = vi.fn(async () => {
      throw unrelated
    })
    await expect(
      openWithoutRefusedCodexServers({ 'mcp_servers.notion.url': 'u' }, again)
    ).rejects.toBe(unrelated)
    expect(open).toHaveBeenCalledTimes(1)
    expect(again).toHaveBeenCalledTimes(1)
  })
})

describe('codexLoadedServers', () => {
  it('names each loaded server with how it runs, and none when the config can’t be read', async () => {
    const loaded = await codexLoadedServers(
      reading({
        config: { mcp_servers: { docs: { command: 'd' }, notion: { url: 'u' }, odd: {} } }
      }),
      '/bot'
    )
    expect(loaded).toEqual(
      new Map([
        ['docs', 'command'],
        ['notion', 'url'],
        ['odd', null]
      ])
    )
    expect(await codexLoadedServers(reading({ config: {} }), '/bot')).toEqual(new Map())
    expect(await codexLoadedServers(reading(new Error('down')), '/bot')).toBeNull()
    expect(await codexLoadedServers(reading({}), '/bot')).toBeNull()
  })
})

describe('codexOnlySentServers', () => {
  it('turns off every named server the config doesn’t send, a left-out one too', () => {
    const sent = { 'mcp_servers.linear.url': 'l', web_search: 'live' }
    expect(codexOnlySentServers(sent, ['docs', 'linear', 'notion'])).toEqual({
      ...sent,
      'mcp_servers.docs.enabled': false,
      'mcp_servers.notion.enabled': false
    })
    expect(codexOnlySentServers(sent, ['linear'])).toBe(sent)
  })
})

describe('openWithoutRefusedCodexServers refusals', () => {
  it('tells each refusal before the next open, and stops when told to', async () => {
    const config = { 'mcp_servers.notion.url': 'n', 'mcp_servers.linear.url': 'l' }
    const heard: string[] = []
    const open = vi.fn(async (sent: Record<string, unknown> | undefined) => {
      if (sent?.['mcp_servers.notion.url']) {
        throw refusal('thread/start', 'notion')
      }
      throw new Error('spawn failed')
    })
    await expect(
      openWithoutRefusedCodexServers(config, open, (name) => heard.push(name))
    ).rejects.toThrow('spawn failed')
    // Heard before the open that then failed, so a caller keeps it.
    expect(heard).toEqual(['notion'])
    expect(open).toHaveBeenCalledTimes(2)

    const stop = new Error('taken')
    const once = vi.fn(async () => {
      throw refusal('thread/start', 'notion')
    })
    await expect(
      openWithoutRefusedCodexServers(config, once, () => {
        throw stop
      })
    ).rejects.toBe(stop)
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('opens again for no timeout', async () => {
    const timeout = new CodexAppServerRequestError(
      'thread/start',
      -32001,
      'codex app-server thread/start timed out after 1000ms'
    )
    const open = vi.fn(async () => {
      throw timeout
    })
    await expect(
      openWithoutRefusedCodexServers({ 'mcp_servers.notion.url': 'n' }, open)
    ).rejects.toBe(timeout)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
