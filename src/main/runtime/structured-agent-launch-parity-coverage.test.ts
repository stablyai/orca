// A newly registered agent must get launch parity snapshots: the oracle lists its agents by hand.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'

const SNAPSHOT = new URL(
  './__snapshots__/structured-agent-launch-parity.test.ts.snap',
  import.meta.url
)

it('snapshots the launch of every registered native-chat agent, and of no other', () => {
  const snapshots = readFileSync(fileURLToPath(SNAPSHOT), 'utf8')
  const snapshotted = new Set(
    [...snapshots.matchAll(/^exports\[`native-chat launch parity > (\S+) /gm)].map(
      ([, agent]) => agent
    )
  )
  const registered = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.map(
    ({ definition }) => definition.agent
  )
  expect([...snapshotted].sort()).toEqual([...registered].sort())
})
