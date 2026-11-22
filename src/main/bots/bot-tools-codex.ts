// A Codex bot's own tools reach its threads as thread config, so they need no folder trust, and a
// thread started anywhere else never sees them.
import type { BotLaunchTools } from './bot-launch-tools'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { BotToolProblem } from '../../shared/bot-tools'
import { readMcpServerTomlOwnership } from '../codex/configuration/toml/config-toml-mcp-servers'

/** The servers as a thread's config: dotted keys add to the owner's servers instead of replacing them. */
export function codexBotToolsThreadConfig(tools: BotLaunchTools): Record<string, unknown> {
  return Object.fromEntries(
    tools.servers.flatMap((server): [string, unknown][] => {
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

/** The owner's own servers in their account's config.toml, which every Codex thread loads. */
export async function readCodexInheritedToolNames(codexHome: string): Promise<string[]> {
  try {
    return [
      ...readMcpServerTomlOwnership(await readFile(join(codexHome, 'config.toml'), 'utf8')).names
    ]
  } catch {
    return []
  }
}

const StatusList = z.object({
  data: z.array(
    z.looseObject({
      name: z.string(),
      runtimeStatus: z.string().optional(),
      toolsError: z.string().nullish()
    })
  )
})

/** What app-server's `mcpServerStatus/list` says is wrong with each of `names`. */
export function codexToolProblems(
  answer: unknown,
  names: readonly string[]
): Map<string, BotToolProblem> {
  const problems = new Map<string, BotToolProblem>(
    names.map((name) => [name, { kind: 'unconfirmed' }])
  )
  for (const server of StatusList.safeParse(answer).data?.data ?? []) {
    if (!names.includes(server.name)) {
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
