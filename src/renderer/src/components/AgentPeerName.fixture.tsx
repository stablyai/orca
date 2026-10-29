import { Terminal } from 'lucide-react'
import { defineFixture } from '../component-fixtures/component-fixture'
import { AgentPeerName } from './AgentPeerName'

function SessionItem(): React.JSX.Element {
  return (
    <div className="flex h-7 min-w-0 items-center gap-1 rounded-sm px-2 text-xs text-muted-foreground">
      <Terminal className="size-3 shrink-0" />
      <AgentPeerName paneKey="peer-fixture:leaf" agentType="claude" />
      <span className="min-w-0 flex-1 truncate">Implement sidebar session names</span>
    </div>
  )
}

export const unnamed = defineFixture({ width: 360, render: () => <SessionItem /> })

export const named = defineFixture({
  width: 360,
  store: {
    paneForegroundAgentByPaneKey: {
      'peer-fixture:leaf': {
        agent: 'claude',
        shellForeground: false,
        agentName: 'Amber Harbor',
        agentPid: 123,
        permissionMode: 'default'
      }
    }
  },
  render: () => <SessionItem />
})
