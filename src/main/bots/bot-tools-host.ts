// A bot's tools on the host that runs it: kept in its home folder, checked and signed in through its
// agent's own CLI, under the account its next turn uses.
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import type {
  BotInheritedTool,
  BotToolProblem,
  BotTools,
  BotToolServer,
  BotToolInput
} from '../../shared/bot-tools'
import { runCodexAppServerSession } from '../codex/app-server/codex-app-server-session'
import {
  claudeMirrorArgs,
  claudeMirrorChanges,
  claudeUnmirrorArgs,
  readClaudeInheritedTools,
  readClaudeMirror
} from './bot-tools-claude'
import {
  codexBotToolsThreadConfig,
  codexToolProblems,
  readCodexInheritedToolNames
} from './bot-tools-codex'
import {
  botOwnTool,
  readBotToolServers,
  changeBotToolServers,
  type BotToolNewCredential
} from './bot-tools-file'
import { resolveBotToolInput } from './bot-tool-details'
import { claudeBotToolProblems } from './bot-tools-claude-check'
import { redactBotToolProblems } from './bot-tool-redaction'
import { cliWithLaunchTools, withRelayProblems, type BotLaunchTools } from './bot-launch-tools'
import { readBotToolOAuth, withSavedBotToolHeaders } from './bot-tool-credentials'

/** The agent CLI a bot's turns run, as the host would launch it now. */
export type BotToolsCli = {
  botId: string
  agent: 'claude' | 'codex'
  folder: string
  /** Claude: a folder of Orca's own where the CLI keeps the bot's servers to sign them in. */
  signInFolder: string
  command: string
  prefixArgs: string[]
  env: Record<string, string>
  /** Claude: its config dir when not the default; Codex: its CODEX_HOME. */
  accountHome: string | null
  /** The home folders of this host's other bots on the same agent, which may share a sign-in. */
  otherBotFolders: readonly string[]
}

const StartedThread = z.object({ thread: z.object({ id: z.string() }) })

const CLI_TIMEOUT_MS = 60_000

const cliEnv = (cli: BotToolsCli): Record<string, string> =>
  cli.agent === 'codex' && cli.accountHome ? { ...cli.env, CODEX_HOME: cli.accountHome } : cli.env

export function runBotToolsCli(cli: BotToolsCli, args: readonly string[], cwd = cli.folder) {
  return runProcess({
    program: cli.command,
    args: [...cli.prefixArgs, ...args],
    cwd,
    env: cliEnv(cli),
    timeoutMs: CLI_TIMEOUT_MS
  })
}

export function codexSession<T>(
  cli: BotToolsCli,
  timeoutMs: number,
  body: Parameters<typeof runCodexAppServerSession<T>>[1],
  signal?: AbortSignal
): Promise<T> {
  return runCodexAppServerSession(
    {
      command: cli.command,
      args: [...cli.prefixArgs, 'app-server'],
      cwd: cli.folder,
      cliPath: cli.command,
      env: cliEnv(cli),
      timeoutMs,
      treeKillOnFinish: true,
      signal
    },
    body
  ).catch(() => {
    throw new Error('Codex could not check or connect the tools. Check its setup and try again.')
  })
}

/** A thread in the bot folder with the bot's own servers, as its turns start one. */
export async function codexThread(
  rpc: Parameters<Parameters<typeof runCodexAppServerSession>[1]>[0],
  cli: BotToolsCli,
  tools: BotLaunchTools
): Promise<string> {
  const started = await rpc.request('thread/start', {
    cwd: cli.folder,
    ephemeral: true,
    config: codexBotToolsThreadConfig(tools)
  })
  const id = StartedThread.safeParse(started).data?.thread.id
  if (!id) {
    throw new Error('Codex started no thread to check the tools in.')
  }
  return id
}

/** The tools the bot gets from its owner's own Claude Code or Codex config. */
export async function inheritedTools(cli: BotToolsCli): Promise<BotInheritedTool[]> {
  if (cli.agent === 'claude') {
    return await readClaudeInheritedTools(cli.accountHome)
  }
  const names = cli.accountHome ? await readCodexInheritedToolNames(cli.accountHome) : []
  return names.map((name) => ({ name }))
}

export async function listBotTools(cli: BotToolsCli): Promise<BotTools> {
  const [servers, inherited] = await Promise.all([
    readBotToolServers(cli.folder),
    inheritedTools(cli)
  ])
  return {
    agent: cli.agent,
    own: servers.map((server) => botOwnTool(server, cli.folder)),
    inherited
  }
}

/**
 * Claude's sign-in folder, made its own git repo so Claude keys its servers to it even under a home
 * kept in git, and mirroring the bot's servers.
 */
export async function claudeSignInFolder(
  cli: BotToolsCli,
  allServers: readonly BotToolServer[]
): Promise<string> {
  // A tool with saved values goes through the relay and never signs in, so Claude's config never holds it.
  const servers = allServers.filter((server) => !('url' in server && server.credential))
  const folder = cli.signInFolder
  await mkdir(folder, { recursive: true })
  if (!existsSync(join(folder, '.git'))) {
    const made = await runProcess({ program: 'git', args: ['init', '-q'], cwd: folder })
    if (made.code !== 0) {
      throw new Error(
        `Couldn't prepare the sign-in folder: ${made.stderr.trim() || 'git init failed'}`
      )
    }
  }
  const mirror = await readClaudeMirror(cli.accountHome, folder)
  for (const name of Object.keys(mirror)) {
    if (!servers.some((server) => server.name === name)) {
      await runBotToolsCli(cli, claudeUnmirrorArgs(name), folder)
    }
  }
  const changes = claudeMirrorChanges(mirror, servers)
  for (const server of changes) {
    await runBotToolsCli(cli, claudeUnmirrorArgs(server.name), folder)
    const added = await runBotToolsCli(cli, claudeMirrorArgs(server), folder)
    if (added.code !== 0) {
      throw new Error(
        `Couldn't prepare ${server.name} in Claude Code. Check its tool configuration.`
      )
    }
  }
  return folder
}

/**
 * Only the bot's own tools that need something; a working one isn't listed. `remote` checks only
 * the URL servers, so no command is started; `signal` stops the check and closes its session.
 */
export async function botToolProblems(
  cli: BotToolsCli,
  { remote = false, signal }: { remote?: boolean; signal?: AbortSignal } = {}
): Promise<Record<string, BotToolProblem>> {
  // A tool Orca signs in to has its state from Orca's own store; checking it would start it.
  const servers = (await readBotToolServers(cli.folder)).filter(
    (server) =>
      (!remote || 'url' in server) &&
      !('url' in server && server.credential && readBotToolOAuth(cli.folder, server.credential))
  )
  if (servers.length === 0) {
    return {}
  }
  signal?.throwIfAborted()
  const names = servers.map((server) => server.name)
  const launch = await cliWithLaunchTools(cli, servers)
  if (cli.agent === 'claude') {
    return withRelayProblems(
      cli,
      servers,
      redactBotToolProblems(await claudeBotToolProblems(launch.cli, launch.tools, signal), servers)
    )
  }
  return codexSession(
    launch.cli,
    CLI_TIMEOUT_MS,
    async (rpc) => {
      const threadId = await codexThread(rpc, launch.cli, launch.tools)
      const deadline = Date.now() + 30_000
      let problems: Map<string, BotToolProblem>
      do {
        signal?.throwIfAborted()
        const answer = await rpc.request('mcpServerStatus/list', {
          threadId,
          detail: 'toolsAndAuthOnly'
        })
        problems = codexToolProblems(answer, names)
        if (![...problems.values()].some((problem) => problem.kind === 'unconfirmed')) {
          break
        }
        await delay(100, undefined, { signal })
      } while (Date.now() < deadline)
      return withRelayProblems(cli, servers, redactBotToolProblems(problems, servers))
    },
    signal
  )
}

/** A name the bot or its owner already uses would merge into, or shadow, the other server. */
export async function botToolNameTaken(
  cli: BotToolsCli,
  name: string,
  editingName?: string
): Promise<string | null> {
  const [servers, inherited] = await Promise.all([
    readBotToolServers(cli.folder),
    inheritedTools(cli)
  ])
  if (servers.some((server) => server.name === name && server.name !== editingName)) {
    return `This bot already has a tool named ${name}.`
  }
  const agent = cli.agent === 'claude' ? 'Claude Code' : 'Codex'
  return inherited.some((tool) => !tool.plugin && tool.name === name)
    ? `Your ${agent} already has a tool named ${name}, which this bot gets too. Pick another name with --name.`
    : null
}

export async function addBotTool(
  cli: BotToolsCli,
  server: BotToolServer,
  credentials?: ReadonlyMap<string, BotToolNewCredential>
): Promise<void> {
  const taken = await botToolNameTaken(cli, server.name)
  if (taken) {
    throw new Error(taken)
  }
  await changeBotToolServers(
    cli.folder,
    (servers) => {
      if (servers.some((entry) => entry.name === server.name)) {
        throw new Error(`This bot already has a tool named ${server.name}.`)
      }
      return [...servers, server]
    },
    undefined,
    undefined,
    credentials
  )
}

export async function updateBotTool(
  cli: BotToolsCli,
  name: string,
  version: string,
  input: BotToolInput
): Promise<BotToolServer> {
  const taken = await botToolNameTaken(cli, input.name, name)
  if (taken) {
    throw new Error(taken)
  }
  let updated: BotToolServer | undefined
  await changeBotToolServers(
    cli.folder,
    (servers) => {
      const previous = servers.find((entry) => entry.name === name)
      if (!previous) {
        throw new Error('This bot no longer has that tool.')
      }
      updated = resolveBotToolInput(input, withSavedBotToolHeaders(cli.folder, previous))
      const replacement = updated
      return servers.map((server) => (server.name === name ? replacement : server))
    },
    version,
    { from: name, to: input.name }
  )
  if (!updated) {
    throw new Error('The tool was not updated.')
  }
  return updated
}
