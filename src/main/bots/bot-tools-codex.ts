// A Codex bot's own tools reach its threads as thread config, so they need no folder trust, and a
// thread started anywhere else never sees them.
import type { SessionMcpTools } from '../mcp-servers/session-mcp-tools'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { botFailure, botFailureEnglish } from '../../shared/bots/bot-failure-copy'
import type { BotToolProblem, BotToolServer } from '../../shared/bot-tools'
import { readMcpServerTomlOwnership } from '../codex/configuration/toml/config-toml-mcp-servers'

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
      .map(({ name }): [string, BotToolProblem] => [
        name,
        {
          kind: 'failed',
          detail: botFailureEnglish(botFailure('toolNameTakenByCodexStdio', { name }))
        }
      ])
  )
}

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
