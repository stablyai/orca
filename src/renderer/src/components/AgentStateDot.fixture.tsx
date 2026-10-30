import { defineFixture } from '../component-fixtures/component-fixture'
import { AgentStateDot, agentStateLabel, type AgentDotState } from './AgentStateDot'

const ALL_STATES: AgentDotState[] = [
  'working',
  'monitoring',
  'blocked',
  'waiting',
  'permission',
  'interrupted',
  'failed',
  'done',
  'idle',
  'unverifiable',
  'unconfirmed'
]

function StateGrid({
  size,
  progress
}: {
  size: 'sm' | 'md'
  progress?: number
}): React.JSX.Element {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
      {ALL_STATES.map((state) => (
        <li key={state} className="flex items-center gap-2">
          <AgentStateDot state={state} size={size} progress={progress} title={null} />
          <span className="text-muted-foreground">{agentStateLabel(state)}</span>
        </li>
      ))}
    </ul>
  )
}

export const allStates = defineFixture({ width: 420, render: () => <StateGrid size="sm" /> })

export const allStatesMedium = defineFixture({ width: 420, render: () => <StateGrid size="md" /> })

export const withProgress = defineFixture({
  width: 420,
  render: () => <StateGrid size="md" progress={42} />
})
