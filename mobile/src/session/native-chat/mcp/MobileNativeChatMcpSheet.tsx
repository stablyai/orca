import { useCallback, useEffect, useRef, useState } from 'react'
import { createAgentSessionMcpPanelHook } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp-panel'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { openExternalLink } from '../../../platform/external-links/external-link'
import type { MobileStructuredMcpPanel } from './use-mobile-structured-mcp-panel'
import { MobileNativeChatMcpPanel } from './MobileNativeChatMcpPanel'

const useAgentSessionMcpPanel = createAgentSessionMcpPanelHook({
  useCallback,
  useEffect,
  useRef,
  useState
})

/** The `/mcp` sheet; each opening reads the servers afresh. */
export function MobileNativeChatMcpSheet({
  panel
}: {
  panel: MobileStructuredMcpPanel | null | undefined
}): React.JSX.Element | null {
  if (!panel) {
    return null
  }
  return (
    <BottomDrawer visible={panel.open} onClose={panel.close}>
      <McpSheetContent panel={panel} />
    </BottomDrawer>
  )
}

function McpSheetContent({ panel }: { panel: MobileStructuredMcpPanel }) {
  const state = useAgentSessionMcpPanel(panel.request, openExternalLink)
  return (
    <MobileNativeChatMcpPanel
      {...state}
      run={(operation) => void state.run(operation)}
      retry={() => void state.retry()}
      openUrl={openExternalLink}
      onClose={panel.close}
    />
  )
}
