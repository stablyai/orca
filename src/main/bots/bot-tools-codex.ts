// A Codex bot's own tools reach its threads as thread config, so they need no folder trust, and a
// thread started anywhere else never sees them.
import type { SessionMcpTools } from '../mcp-servers/session-mcp-tools'
import type { BotToolsCli } from './bot-tools-host'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { BotFailureError, botFailure, botFailureEnglish } from '../../shared/bots/bot-failure-copy'
import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'
import type { CodexAppServerRpc } from '../codex/app-server/codex-app-server-session'
import { readMcpServerTomlOwnership } from '../codex/configuration/toml/config-toml-mcp-servers'
import {
  codexOnlySentServers,
  openWithoutRefusedCodexServers,
  withoutCodexMcpConflicts,
  withoutCodexServers
} from './bot-tools-codex-conflicts'

/** A bot url server that Codex would merge into the owner's stdio server of the same name. */
export function isTakenByCodexStdio(
  server: BotToolServer,
  ownerStdioNames: ReadonlySet<string>
): boolean {
  return 'url' in server && ownerStdioNames.has(server.name)
}

/**
 * The servers as a thread's config: dotted keys add to the owner's servers instead of replacing them.
 * Codex merges a server into the owner's of the same name, and a url merged into the owner's stdio
 * server stops every thread from starting, so such a server is left out and theirs runs instead.
 */
export function codexBotToolsThreadConfig(
  tools: SessionMcpTools,
  ownerStdioNames: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(
    tools.servers.flatMap((server): [string, unknown][] => {
      if (isTakenByCodexStdio(server, ownerStdioNames)) {
        return []
      }
      const key = `mcp_servers.${server.name}`
      if ('url' in server) {
        const entries: [string, unknown][] = [[`${key}.url`, server.url]]
        if (server.headers) {
          entries.push([`${key}.http_headers`, server.headers])
        }
        return entries
      }
      const entries: [string, unknown][] = [
        [`${key}.command`, server.command],
        [`${key}.args`, server.args]
      ]
      return server.env ? [...entries, [`${key}.env`, server.env]] : entries
    })
  )
}

const StartedThread = lazyZodSchema(() => z.object({ thread: z.object({ id: z.string() }) }))

/** How `codexThread` treats the servers Codex's config can't take. */
export type CodexThreadFit = {
  /** Already read: these are left out and the config isn't read again. */
  refused?: readonly string[]
  /** Hears each left-out name before the next open (one read before any); throwing stops there. */
  onRefused?: (name: string) => void
  /** A check's thread starts none of these but the bot's own: each open turns off every one it
   *  doesn't send, and every name Codex refused at an open before. */
  onlySent?: Iterable<string>
}

/**
 * A thread in the bot folder with the bot's own servers, as its turns start one. `leftOut` are the
 * ones Codex's config has under the same name as the other kind, which the thread can't add.
 */
export async function codexThread(
  rpc: Pick<CodexAppServerRpc, 'request'>,
  cli: Pick<BotToolsCli, 'folder'>,
  tools: SessionMcpTools,
  ownerStdioNames: ReadonlySet<string>,
  fit: CodexThreadFit = {}
): Promise<{ threadId: string; leftOut: string[] }> {
  const all = codexBotToolsThreadConfig(tools, ownerStdioNames)
  const fitted = fit.refused
    ? { threadConfig: withoutCodexServers(all, fit.refused), leftOut: [...fit.refused] }
    : await withoutCodexMcpConflicts(rpc, cli.folder, all)
  for (const name of fitted.leftOut) {
    fit.onRefused?.(name)
  }
  const refusedAtOpen: string[] = []
  const isolated = (config: Record<string, unknown>): Record<string, unknown> =>
    fit.onlySent ? codexOnlySentServers(config, [...fit.onlySent, ...refusedAtOpen]) : config
  const { opened, leftOut } = await openWithoutRefusedCodexServers(
    fitted.threadConfig,
    (config) =>
      rpc.request('thread/start', {
        cwd: cli.folder,
        ephemeral: true,
        config: isolated(config ?? {})
      }),
    (name) => {
      refusedAtOpen.push(name)
      fit.onRefused?.(name)
    }
  )
  const id = StartedThread.safeParse(opened).data?.thread.id
  if (!id) {
    throw new BotFailureError('toolCodexNoThread')
  }
  return { threadId: id, leftOut: [...new Set([...fitted.leftOut, ...leftOut])] }
}

async function readCodexOwnerServers(
  codexHome: string
): Promise<ReturnType<typeof readMcpServerTomlOwnership>> {
  try {
    return readMcpServerTomlOwnership(await readFile(join(codexHome, 'config.toml'), 'utf8'))
  } catch {
    return readMcpServerTomlOwnership('')
  }
}

/** The owner's own servers in their account's config.toml, which every Codex thread loads. */
export async function readCodexInheritedToolNames(codexHome: string): Promise<string[]> {
  return [...(await readCodexOwnerServers(codexHome)).names]
}

/** The owner's stdio servers in that config.toml, which a bot's url server of the same name breaks. */
export async function readCodexStdioToolNames(codexHome: string): Promise<ReadonlySet<string>> {
  return (await readCodexOwnerServers(codexHome)).commandNames
}

/** Each bot url server named like an owner's stdio server: its threads run the owner's server instead. */
export function codexTakenToolProblems(
  servers: readonly BotToolServer[],
  ownerStdioNames: ReadonlySet<string>
): Record<string, BotToolProblem> {
  return Object.fromEntries(
    servers
      .filter((server) => isTakenByCodexStdio(server, ownerStdioNames))
      .map(({ name }): [string, BotToolProblem] => [name, codexTakenToolProblem(name)])
  )
}

/** A bot server whose name Codex's own config already runs as the other kind (command or URL). */
export const codexTakenToolProblem = (name: string): BotToolProblem => ({
  kind: 'failed',
  reason: 'nameTaken',
  detail: botFailureEnglish(botFailure('toolNameTakenByCodexStdio', { name }))
})

const StatusList = lazyZodSchema(() =>
  z.object({
    data: z.array(
      z.looseObject({
        name: z.string(),
        runtimeStatus: z.string().optional(),
        toolsError: z.string().nullish()
      })
    )
  })
)

/** What app-server's `mcpServerStatus/list` says is wrong with each of `names`. */
export function codexToolProblems(
  answer: unknown,
  names: readonly string[]
): Map<string, BotToolProblem> {
  const problems = new Map<string, BotToolProblem>(
    names.map((name) => [name, { kind: 'unconfirmed' }])
  )
  const wanted = new Set(names)
  for (const server of StatusList.safeParse(answer).data?.data ?? []) {
    if (!wanted.has(server.name)) {
      continue
    }
    if (server.runtimeStatus === 'connected') {
      problems.delete(server.name)
    } else if (server.runtimeStatus === 'authenticationRequired') {
      problems.set(server.name, { kind: 'sign-in' })
    } else if (
      server.runtimeStatus === 'failed' ||
      (server.toolsError && server.runtimeStatus !== 'connected')
    ) {
      problems.set(server.name, {
        kind: 'failed',
        ...(server.toolsError ? { detail: server.toolsError.slice(0, 400) } : {})
      })
    }
  }
  return problems
}

/**
 * `codexToolProblems` for `names` on `threadId`, asked until none is unconfirmed or 30s pass.
 * `seen` keeps each name's latest definite answer (null: working), so one that a later ask fails
 * after is still known: a failed ask changes nothing, a newer answer replaces the older.
 */
export async function settledCodexToolProblems(
  rpc: Pick<CodexAppServerRpc, 'request'>,
  threadId: string,
  names: readonly string[],
  signal?: AbortSignal,
  seen?: Map<string, BotToolProblem | null>
): Promise<Map<string, BotToolProblem>> {
  if (names.length === 0) {
    return new Map()
  }
  const deadline = Date.now() + 30_000
  let problems: Map<string, BotToolProblem>
  do {
    signal?.throwIfAborted()
    const answer = await rpc.request('mcpServerStatus/list', {
      threadId,
      detail: 'toolsAndAuthOnly'
    })
    problems = codexToolProblems(answer, names)
    for (const name of names) {
      const problem = problems.get(name)
      if (!problem || problem.kind !== 'unconfirmed') {
        seen?.set(name, problem ?? null)
      }
    }
    if (![...problems.values()].some((problem) => problem.kind === 'unconfirmed')) {
      break
    }
    await delay(100, undefined, { signal })
  } while (Date.now() < deadline)
  return problems
}
