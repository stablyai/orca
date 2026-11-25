// The MCP servers screens' changes: each one asks first where the mocks do (an agent's own settings
// file, Move, Remove), shows the host's answer at once, and says it applies to new sessions with a
// Restart action once the host can count the terminals still on the old list.
import { useCallback, useRef, useState } from 'react'
import { MCP_FILE_AGENTS, type McpFileAgent } from '../../../src/shared/mcp-servers/mcp-servers'
import { formatAgentTypeLabel } from '../../../src/shared/agent-status/presentation/agent-type-label'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { mcpServerTitle } from './mcp-server-words'
import {
  mcpServerAgentFilesAllow,
  mcpServerCopy,
  mcpServerMove,
  mcpServerRemove,
  mcpServerSetAgentEnabled,
  mcpServerSetSharedProcess,
  mcpServerSetWorkspaces,
  mcpServerSignOut,
  mcpSessionsRestart,
  mcpSessionsStaleRead,
  type PhoneDiscoveredMcpServer,
  type PhoneMcpServer,
  type PhoneMcpServerList,
  type PhoneMcpWorkspaces
} from './mcp-server-operations'

export type McpConfirm = {
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
}

export type McpToastAction = { label: string; onPress: () => void }

const AGENT_FILES: Record<McpFileAgent, string> = {
  grok: '~/.grok/config.toml',
  cursor: '~/.cursor/mcp.json',
  droid: '~/.factory/mcp.json'
}

const isFileAgent = (agent: string): agent is McpFileAgent =>
  MCP_FILE_AGENTS.some((fileAgent) => fileAgent === agent)

// Gemini CLI isn't an agent Orca launches, but its settings can still hold servers.
const AGENT_NAMES: Partial<Record<string, string>> = { claude: 'Claude Code', gemini: 'Gemini CLI' }

/** An agent as the bots and the mocks name it: "Claude Code", "GitHub Copilot". */
export const mcpAgentName = (agent: string): string =>
  AGENT_NAMES[agent] ?? formatAgentTypeLabel(agent)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function useMcpServerActions(args: {
  client: RpcClient | null
  list: PhoneMcpServerList | null
  applyServer: (server: PhoneMcpServer | null, removedId?: string) => void
  showToast: (message: string, action?: McpToastAction) => void
  t: Translate
}) {
  const { client, list, applyServer, showToast, t } = args
  const [confirm, setConfirm] = useState<McpConfirm | null>(null)

  const run = useCallback(
    async <T>(work: (client: RpcClient) => Promise<T>): Promise<T | null> => {
      if (!client) {
        return null
      }
      try {
        return await work(client)
      } catch (error) {
        showToast(messageOf(error))
        return null
      }
    },
    [client, showToast]
  )

  /** "Applies to new sessions", with Restart when terminals still run the old list. */
  const sayApplies = useCallback(async () => {
    const applies = t('mcpServers.appliesToNew', 'Applies to new sessions')
    const stale = client
      ? await mcpSessionsStaleRead
          .request(client, {})
          .then((reply) => mcpSessionsStaleRead.interpret(reply))
          // A host without the count yet says it applies, with nothing to restart.
          .catch(() => null)
      : null
    if (!stale || stale.restartable === 0) {
      showToast(applies)
      return
    }
    showToast(applies, {
      label: t('mcpServers.restartSessions', 'Restart {{count}} sessions', {
        count: stale.restartable
      }),
      onPress: () =>
        void run(async (live) => {
          const done = mcpSessionsRestart.interpret(await mcpSessionsRestart.request(live, {}))
          showToast(
            t('mcpServers.restarted', 'Restarted {{count}} sessions', { count: done.restarted })
          )
        })
    })
  }, [client, run, showToast, t])

  const change = useCallback(
    async (work: (client: RpcClient) => Promise<{ server: PhoneMcpServer }>) => {
      const answer = await run(work)
      if (answer) {
        applyServer(answer.server)
        void sayApplies()
      }
    },
    [run, applyServer, sayApplies]
  )

  const enable = useCallback(
    (server: PhoneMcpServer, agents: readonly string[], enabled: boolean) =>
      change(async (live) => {
        let last: { server: PhoneMcpServer } | null = null
        for (const agent of agents) {
          last = mcpServerSetAgentEnabled.interpret(
            await mcpServerSetAgentEnabled.request(live, { id: server.id, agent, enabled })
          )
        }
        return last ?? { server }
      }),
    [change]
  )

  /** Turns agents on or off; a file-based agent Orca hasn't been let into asks first. */
  const setAgents = useCallback(
    (server: PhoneMcpServer, agents: readonly string[], enabled: boolean) => {
      const asking = enabled
        ? agents.filter(isFileAgent).filter((agent) => list?.agentFiles[agent] !== true)
        : []
      if (asking.length === 0) {
        void enable(server, agents, enabled)
        return
      }
      const names = asking.map(mcpAgentName)
      const one = asking.length === 1
      setConfirm({
        title: t('mcpServers.agentFileTitle', 'Turn on {{server}} for {{agent}}?', {
          server: mcpServerTitle(server),
          agent: new Intl.ListFormat(getUiIntlLocale(), { type: 'conjunction' }).format(names)
        }),
        message: one
          ? t(
              'mcpServers.agentFileMessage',
              'Orca will keep your MCP servers in {{agent}}’s settings file ({{file}}). Your own entries stay as they are.',
              { agent: names[0], file: AGENT_FILES[asking[0]] }
            )
          : t(
              'mcpServers.agentFilesMessage',
              'Orca will keep your MCP servers in their settings files. Your own entries stay as they are.'
            ),
        confirmLabel: t('mcpServers.allow', 'Allow'),
        onConfirm: () =>
          void run(async (live) => {
            for (const agent of asking) {
              mcpServerAgentFilesAllow.interpret(
                await mcpServerAgentFilesAllow.request(live, { agent, allowed: true })
              )
            }
            return true
          }).then((allowed) => {
            if (allowed) {
              void enable(server, agents, enabled)
            }
          })
      })
    },
    [list, enable, run, t]
  )

  // Each write names the whole choice, so they go one at a time in the order they were made.
  const workspaceWrites = useRef<Promise<void>>(Promise.resolve())
  const setWorkspaces = useCallback(
    (server: PhoneMcpServer, workspaces: PhoneMcpWorkspaces): Promise<void> => {
      const write = workspaceWrites.current.then(() =>
        change(async (live) =>
          mcpServerSetWorkspaces.interpret(
            await mcpServerSetWorkspaces.request(live, { id: server.id, workspaces })
          )
        )
      )
      workspaceWrites.current = write
      return write
    },
    [change]
  )

  const setShared = useCallback(
    (server: PhoneMcpServer, enabled: boolean) =>
      void change(async (live) =>
        mcpServerSetSharedProcess.interpret(
          await mcpServerSetSharedProcess.request(live, { id: server.id, enabled })
        )
      ),
    [change]
  )

  const signOut = useCallback(
    (server: PhoneMcpServer) =>
      void run(async (live) => {
        applyServer(
          mcpServerSignOut.interpret(await mcpServerSignOut.request(live, { id: server.id })).server
        )
      }),
    [run, applyServer]
  )

  const remove = useCallback(
    (server: PhoneMcpServer, onRemoved: () => void) =>
      setConfirm({
        title: t('mcpServers.removeTitle', 'Remove {{name}}?', { name: mcpServerTitle(server) }),
        message: t(
          'mcpServers.removeMessage',
          'New sessions won’t have it. You can add it again any time.'
        ),
        confirmLabel: t('mcpServers.remove', 'Remove'),
        destructive: true,
        onConfirm: () =>
          void run(async (live) => {
            mcpServerRemove.interpret(await mcpServerRemove.request(live, { id: server.id }))
            onRemoved()
            applyServer(null, server.id)
          })
      }),
    [run, applyServer, t]
  )

  const copy = useCallback(
    (entry: PhoneDiscoveredMcpServer) =>
      void run(async (live) => {
        applyServer(
          mcpServerCopy.interpret(await mcpServerCopy.request(live, { key: entry.key })).server
        )
      }),
    [run, applyServer]
  )

  const move = useCallback(
    (entry: PhoneDiscoveredMcpServer) =>
      setConfirm({
        title: t('mcpServers.moveTitle', 'Move {{name}} to Orca?', { name: entry.name }),
        message: t(
          'mcpServers.moveMessage',
          'Orca removes it from {{agents}} settings and keeps a backup.',
          {
            agents: new Intl.ListFormat(getUiIntlLocale(), { type: 'conjunction' }).format(
              entry.agents.map(mcpAgentName)
            )
          }
        ),
        confirmLabel: t('mcpServers.move', 'Move'),
        onConfirm: () =>
          void run(async (live) => {
            applyServer(
              mcpServerMove.interpret(await mcpServerMove.request(live, { key: entry.key })).server
            )
          })
      }),
    [run, applyServer, t]
  )

  return {
    confirm,
    closeConfirm: () => setConfirm(null),
    setAgents,
    setWorkspaces,
    setShared,
    signOut,
    remove,
    copy,
    move
  }
}
