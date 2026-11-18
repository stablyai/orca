import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { useBotToolCredentialsRoot } from '../bots/bot-tool-credentials'
import type { BotToolsCli } from '../bots/bot-tools-host'
import { ComposioApi } from './composio-api'

const dirs: string[] = []

/** Gives each test its own credential store and temp folders, removed after it. */
export function isolateComposioTestDirs(): void {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'composio-credentials-'))
    dirs.push(root)
    useBotToolCredentialsRoot(root)
  })
  afterEach(() => {
    useBotToolCredentialsRoot(null)
    vi.useRealTimers()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

export function cliFor(): BotToolsCli {
  const root = mkdtempSync(join(tmpdir(), 'composio-bots-'))
  dirs.push(root)
  const home = join(root, 'account')
  mkdirSync(home)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: {} }))
  return {
    botId: 'bot-1',
    agent: 'claude',
    folder: join(root, 'bot'),
    signInFolder: join(root, 'sign-in'),
    command: 'claude',
    prefixArgs: [],
    env: {},
    accountHome: home,
    otherBotFolders: []
  }
}

export type Route = (init: RequestInit | undefined, url: URL) => { status?: number; body: unknown }

/** A Composio stand-in: each route answers `METHOD /path`, and every call is recorded. */
export function fakeComposio(routes: Record<string, Route>) {
  const calls: { method: string; path: string; key: string | null; body: unknown }[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace('/api/v3.1', '')
    const headers = new Headers(init?.headers)
    calls.push({
      method,
      path,
      key: headers.get('x-api-key'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    })
    const route =
      routes[`${method} ${path}`] ??
      Object.entries(routes).find(([pattern]) => {
        const [m, p] = pattern.split(' ')
        return m === method && p.endsWith('*') && path.startsWith(p.slice(0, -1))
      })?.[1]
    const answer = route ? route(init, url) : { status: 404, body: { error: { message: 'nope' } } }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  })
  return { calls, api: (key: string) => new ComposioApi(key, fetchImpl) }
}

export const SESSION = (id: string) => ({
  body: { session_id: id, mcp: { url: `https://backend.composio.dev/tool_router/${id}/mcp` } }
})
