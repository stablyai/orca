import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWindowDimensions } from 'react-native'
import type { AgentSessionMcpServer } from '../../../../../src/shared/agent-session/options/protocol/agent-session-mcp'
import type { BotToolProblem } from '../../../../../src/shared/bot-tools'
import { createAgentSessionMcpPanelHook } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp-panel'
import {
  hasUncheckedOrcaMcpServers,
  ORCA_MCP_SOURCE,
  withOrcaMcpProblems
} from '../../../../../src/shared/agent-session/view/agent-session-mcp-server-presentation'
import {
  MobileMcpSignInSheet,
  type McpSignInTarget
} from '../../../mcp-servers/MobileMcpSignInSheet'
import {
  mcpServerProblemsCancel,
  mcpServerProblemsRead
} from '../../../mcp-servers/mcp-server-operations'
import { useMcpHostName } from '../../../mcp-servers/use-mcp-host-name'
import { openExternalLink } from '../../../platform/external-links/external-link'
import { useMobileNativeChatLowerGeometry } from '../lower-region/mobile-native-chat-lower-region-context'
import type { MobileStructuredMcpPanel } from './use-mobile-structured-mcp-panel'
import { MobileNativeChatMcpPanel } from './MobileNativeChatMcpPanel'

const useAgentSessionMcpPanel = createAgentSessionMcpPanelHook({
  useCallback,
  useEffect,
  useRef,
  useState
})

// Of the chat's visible height, which shrinks while the keyboard is up; Orca's group above the
// agent's own gets more of it.
const LIST_SHARE = 0.4
const LIST_SHARE_WITH_ORCA = 0.5
// The host's check starts every server in its list; Settings waits as long.
const PROBLEMS_TIMEOUT_MS = 120_000
const NO_PROBLEMS: Readonly<Record<string, BotToolProblem>> = {}

/** The `/mcp` tray on the composer's top edge; each opening reads the servers afresh. */
export function MobileNativeChatMcpTray({
  panel
}: {
  panel: MobileStructuredMcpPanel | null | undefined
}): React.JSX.Element | null {
  return panel?.open ? <McpTrayContent panel={panel} /> : null
}

/**
 * While `checks` (an at-rest chat lists Orca servers), the host list's problems by server id, from
 * the same check its MCP servers page runs; one run per tray opening, ended when the tray closes.
 */
function useOrcaMcpProblems(
  orca: MobileStructuredMcpPanel['orca'],
  checks: boolean
): Readonly<Record<string, BotToolProblem>> {
  const [problems, setProblems] = useState(NO_PROBLEMS)
  const client = orca?.client
  const agent = orca?.agent
  useEffect(() => {
    if (!client || !checks) {
      return undefined
    }
    let live = true
    const params = agent === 'claude' || agent === 'codex' ? { agent } : {}
    void mcpServerProblemsRead
      .request(client, params, { timeoutMs: PROBLEMS_TIMEOUT_MS })
      .then((reply) => {
        if (live) {
          setProblems(mcpServerProblemsRead.interpret(reply).problems)
        }
      })
      // A check that can't run leaves the rows as the host listed them.
      .catch(() => {})
    return () => {
      live = false
      void mcpServerProblemsCancel.request(client, {}).catch(() => {})
    }
  }, [agent, checks, client])
  return problems
}

function McpTrayContent({ panel }: { panel: MobileStructuredMcpPanel }) {
  const state = useAgentSessionMcpPanel(panel.request, openExternalLink, panel.refreshKey)
  // Before the agent starts, Orca checks its own servers and signs in to them itself.
  const problems = useOrcaMcpProblems(
    panel.orca,
    panel.orca !== null && hasUncheckedOrcaMcpServers(state.servers)
  )
  const servers = useMemo(
    () => withOrcaMcpProblems(state.servers, problems),
    [state.servers, problems]
  )
  const hostName = useMcpHostName(panel.orca?.hostId ?? '')
  const [signingIn, setSigningIn] = useState<McpSignInTarget | null>(null)
  const readAgain = state.retry
  const signInWithOrca = useCallback((server: AgentSessionMcpServer) => {
    if (server.orca?.url) {
      setSigningIn({ id: server.orca.id, name: server.name, detail: server.orca.url })
    }
  }, [])
  const window = useWindowDimensions()
  const { allocationHeight } = useMobileNativeChatLowerGeometry()
  const visibleHeight = allocationHeight ? Math.min(window.height, allocationHeight) : window.height
  return (
    <>
      <MobileNativeChatMcpPanel
        {...state}
        servers={servers}
        {...(panel.orca ? { signInWithOrca } : {})}
        run={(operation) => void state.run(operation)}
        retry={() => void state.retry()}
        openUrl={openExternalLink}
        onClose={panel.close}
        onManage={panel.manage}
        agentLabel={panel.agentLabel}
        listMaxHeight={Math.round(
          visibleHeight *
            (servers.some((server) => server.source === ORCA_MCP_SOURCE)
              ? LIST_SHARE_WITH_ORCA
              : LIST_SHARE)
        )}
      />
      <MobileMcpSignInSheet
        client={panel.orca?.client ?? null}
        server={signingIn}
        hostName={hostName}
        online
        onClose={() => setSigningIn(null)}
        onSignedIn={() => {
          setSigningIn(null)
          void readAgain()
        }}
      />
    </>
  )
}
