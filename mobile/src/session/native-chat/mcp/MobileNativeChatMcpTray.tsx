import { useCallback, useEffect, useRef, useState } from 'react'
import { useWindowDimensions } from 'react-native'
import { createAgentSessionMcpPanelHook } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp-panel'
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

// Of the chat's visible height, which shrinks while the keyboard is up.
const LIST_SHARE = 0.5

/** The `/mcp` tray on the composer's top edge; each opening reads the servers afresh. */
export function MobileNativeChatMcpTray({
  panel
}: {
  panel: MobileStructuredMcpPanel | null | undefined
}): React.JSX.Element | null {
  return panel?.open ? <McpTrayContent panel={panel} /> : null
}

function McpTrayContent({ panel }: { panel: MobileStructuredMcpPanel }) {
  const state = useAgentSessionMcpPanel(panel.request, openExternalLink, panel.refreshKey)
  const window = useWindowDimensions()
  const { allocationHeight } = useMobileNativeChatLowerGeometry()
  const visibleHeight = allocationHeight ? Math.min(window.height, allocationHeight) : window.height
  return (
    <MobileNativeChatMcpPanel
      {...state}
      run={(operation) => void state.run(operation)}
      retry={() => void state.retry()}
      openUrl={openExternalLink}
      onClose={panel.close}
      onManage={panel.manage}
      listMaxHeight={Math.round(visibleHeight * LIST_SHARE)}
    />
  )
}
