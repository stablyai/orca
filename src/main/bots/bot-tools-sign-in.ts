// Signing a bot's own tool in: the agent's CLI names the page to open and waits on its own localhost
// callback, which a browser on another computer can't reach, so the address it ended on can be pasted back.
import { BotFailureError } from '../../shared/bots/bot-failure-copy'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { BotToolServer } from '../../shared/bot-tools'
import { ensureNodePtySpawnHelperExecutable } from '../providers/local-pty/local-pty-executable-spawn'
import { codexToolProblems } from './bot-tools-codex'
import { redactBotToolText } from './bot-tool-redaction'
import { readBotToolServers } from './bot-tools-file'
import {
  claudeSignInFolder,
  codexSession,
  codexThread,
  hasBotToolsCli,
  type BotToolsCli,
  type BotToolsHome
} from './bot-tools-host'
import { cliWithLaunchTools } from './bot-launch-tools'
import { advanceBotToolsEpoch } from './bot-tools-revision'

const LoginStarted = z.object({ authorizationUrl: z.string() })

// Time to finish signing in in the browser.
const SIGN_IN_TIMEOUT_MS = 600_000
const LINK_WAIT_MS = 30_000

export type BotToolSignInStatus = 'pending' | 'done' | 'failed' | 'none'

type SignIn = {
  /** Where it waits for the browser, so a pasted address goes only there. */
  callback: string | null
  status: Exclude<BotToolSignInStatus, 'none'>
}

// The latest sign-in per bot and tool; its CLI reports the outcome, so watching it runs nothing.
const signIns = new Map<string, SignIn>()
const signInKey = (botId: string, name: string) => `${botId}\0${name}`

function callbackOf(authorizationUrl: string | null): string | null {
  try {
    return authorizationUrl ? new URL(authorizationUrl).searchParams.get('redirect_uri') : null
  } catch {
    // A page with no callback of its own can't be finished by pasting.
    return null
  }
}

/** How the last sign-in this host started for the tool went; 'none' when it started none. */
export function botToolSignInStatus(botId: string, name: string): BotToolSignInStatus {
  return signIns.get(signInKey(botId, name))?.status ?? 'none'
}

/** Drops a removed tool's sign-in, or every one of a deleted bot's. */
export function forgetBotToolSignIns(botId: string, name?: string): void {
  for (const key of signIns.keys()) {
    if (name === undefined ? key.startsWith(`${botId}\0`) : key === signInKey(botId, name)) {
      signIns.delete(key)
    }
  }
}

/**
 * Starts a tool's browser sign-in and answers with the page to open once the CLI names it; the CLI
 * keeps waiting for the browser on this host. Null: the CLI opened the browser itself.
 */
export async function connectBotTool(
  botId: string,
  name: string,
  resolveCli: () => Promise<BotToolsHome>
): Promise<{ authorizationUrl: string | null }> {
  // Pending from the start, replacing any earlier try: the CLI can take seconds to name its page,
  // and a client waiting on this must not read an earlier try's outcome, or none, meanwhile.
  const signIn: SignIn = { callback: null, status: 'pending' }
  signIns.set(signInKey(botId, name), signIn)
  const started = resolveCli().then(async (cli) => ({
    folder: cli.folder,
    ...(await startLogin(cli, name))
  }))
  started.catch(() => {
    signIn.status = 'failed'
  })
  const { authorizationUrl, finished, folder } = await started
  signIn.callback = callbackOf(authorizationUrl)
  void finished.then(
    (signedIn) => {
      signIn.status = signedIn ? 'done' : 'failed'
      if (signedIn) {
        // Open chats of this bot start again at their next turn to pick the sign-in up.
        advanceBotToolsEpoch(folder)
      }
    },
    () => {
      signIn.status = 'failed'
    }
  )
  return { authorizationUrl }
}

/**
 * Finishes a sign-in whose browser ran on another computer: the address it ended on names this
 * host's callback, which only this host can reach.
 */
export async function finishBotToolSignIn(
  cli: Pick<BotToolsHome, 'botId'>,
  name: string,
  address: string
): Promise<void> {
  const signIn = signIns.get(signInKey(cli.botId, name))
  const callback = signIn?.status === 'pending' ? signIn.callback : null
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    throw new BotFailureError('toolSignInAddressIncomplete')
  }
  const expected = callback ? new URL(callback) : null
  if (
    !expected ||
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    !url.searchParams.get('code')
  ) {
    throw new BotFailureError('toolSignInAddressWrong')
  }
  const answer = await fetch(url, { redirect: 'manual' }).catch(() => null)
  if (!answer || answer.status >= 400) {
    throw new BotFailureError('toolSignInEnded')
  }
}

async function startLogin(
  cli: BotToolsHome,
  name: string
): Promise<{ authorizationUrl: string | null; finished: Promise<boolean> }> {
  const servers = await readBotToolServers(cli.folder)
  const server = servers.find((entry) => entry.name === name)
  if (!server) {
    throw new BotFailureError('toolNotFound', { name })
  }
  if ('url' in server && server.credential) {
    throw new BotFailureError('toolNeedsNoSignIn', { name })
  }
  if (!hasBotToolsCli(cli)) {
    throw new BotFailureError('toolSignInAgentUnsupported', { name })
  }
  return cli.agent === 'codex' ? codexLogin(cli, servers, name) : claudeLogin(cli, servers, name)
}

async function codexLogin(
  cli: BotToolsCli,
  servers: readonly BotToolServer[],
  name: string
): Promise<{ authorizationUrl: string; finished: Promise<boolean> }> {
  const link = Promise.withResolvers<string>()
  const launch = await cliWithLaunchTools(cli, servers)
  const login = codexSession(launch.cli, SIGN_IN_TIMEOUT_MS, async (rpc) => {
    const threadId = await codexThread(rpc, launch.cli, launch.tools)
    const started = await rpc.request('mcpServer/oauth/login', { name, threadId })
    const url = LoginStarted.safeParse(started).data?.authorizationUrl
    if (!url) {
      throw new BotFailureError('toolCodexNoSignInPage', { name })
    }
    link.resolve(url)
    // The session must stay up until the browser reaches its callback.
    return await waitUntil(SIGN_IN_TIMEOUT_MS, async () => {
      const answer = await rpc.request('mcpServerStatus/list', {
        threadId,
        serverName: name,
        detail: 'toolsAndAuthOnly'
      })
      return !codexToolProblems(answer, [name]).has(name)
    })
  })
  login.catch((error: unknown) => link.reject(error))
  return { authorizationUrl: await link.promise, finished: login }
}

async function waitUntil(timeoutMs: number, done: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await done()) {
      return true
    }
    await delay(2_000)
  }
  return false
}

// Claude hands BROWSER the page; this writes it where Orca reads it and opens nothing.
const LINK_HELPER = `#!/bin/sh\nprintf '%s' "$1" > "$0.tmp" && mv "$0.tmp" "$0.link"\n`

/** `claude mcp login` needs a terminal; it waits on its own localhost callback until the browser returns. */
async function claudeLogin(
  cli: BotToolsCli,
  servers: readonly BotToolServer[],
  name: string
): Promise<{ authorizationUrl: string | null; finished: Promise<boolean> }> {
  const folder = await claudeSignInFolder(cli, servers)
  // Windows has no sh for the helper, so Claude opens the browser there itself.
  const capture = process.platform !== 'win32'
  const dir = await mkdtemp(join(tmpdir(), 'orca-bot-tool-sign-in-'))
  const helper = join(dir, 'browser')
  if (capture) {
    await writeFile(helper, LINK_HELPER, { mode: 0o700 })
  }
  ensureNodePtySpawnHelperExecutable()
  const pty = await import('node-pty')
  const child = pty.spawn(cli.command, [...cli.prefixArgs, 'mcp', 'login', name], {
    cwd: folder,
    env: { ...cli.env, ...(capture ? { BROWSER: helper } : {}) },
    cols: 120,
    rows: 30
  })
  let output = ''
  child.onData((data) => {
    output = `${output}${data}`.slice(-4000)
  })
  const exited = new Promise<number>((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)))
  const timer = setTimeout(() => child.kill(), SIGN_IN_TIMEOUT_MS)
  void exited.finally(() => {
    clearTimeout(timer)
    void rm(dir, { recursive: true, force: true })
  })
  // `claude mcp login` exits 0 once the browser has signed it in.
  const finished = exited.then((code) => code === 0)
  if (!capture) {
    return { authorizationUrl: null, finished }
  }
  const deadline = Date.now() + LINK_WAIT_MS
  while (Date.now() < deadline) {
    const link = await readFile(`${helper}.link`, 'utf8').catch(() => null)
    if (link) {
      return { authorizationUrl: link.trim(), finished }
    }
    const code = await Promise.race([exited, delay(250).then(() => null)])
    if (code !== null) {
      const said = lastLine(redactBotToolText(output, servers))
      throw said === null
        ? new BotFailureError('toolClaudeSignInFailed', { name })
        : new Error(said)
    }
  }
  child.kill()
  throw new BotFailureError('toolClaudeNoSignInPage', { name })
}

// eslint-disable-next-line no-control-regex -- terminal output carries escape sequences.
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

function lastLine(output: string): string | null {
  const lines = output
    .replace(ESCAPES, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? null
}
