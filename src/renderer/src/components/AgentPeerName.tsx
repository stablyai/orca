import { useAppStore } from '@/store'

/** Shows the Claude peer name for a pane; other agents render nothing. */
export function AgentPeerName({
  paneKey,
  agentType
}: {
  paneKey: string
  agentType: string
}): React.JSX.Element | null {
  const name = useAppStore((state) =>
    agentType === 'claude' ? state.paneForegroundAgentByPaneKey[paneKey]?.agentName : undefined
  )
  return name ? (
    <span
      className="max-w-32 shrink-0 truncate font-mono text-2xs text-muted-foreground"
      title={name}
    >
      {name}
    </span>
  ) : null
}
