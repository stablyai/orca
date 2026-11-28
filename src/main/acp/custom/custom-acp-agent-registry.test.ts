import { expect, it } from 'vitest'
import { customAcpLaunchSpecFor, syncCustomAcpAgents } from './custom-acp-agent-registry'

const agent = (command: string) => ({
  id: 'custom-acp-restore',
  name: 'Restore',
  command,
  args: [],
  env: {}
})

// The host caches the adapter built from an agent's spec, so the id keeps one spec object.
it('restores a removed agent into the spec its cached adapter was built from', () => {
  syncCustomAcpAgents([agent('/opt/old')])
  const spec = customAcpLaunchSpecFor('custom-acp-restore')
  syncCustomAcpAgents([])
  expect(customAcpLaunchSpecFor('custom-acp-restore')).toBeNull()
  syncCustomAcpAgents([agent('/opt/new')])
  expect(customAcpLaunchSpecFor('custom-acp-restore')).toBe(spec)
  expect(spec?.command).toBe('/opt/new')
})
