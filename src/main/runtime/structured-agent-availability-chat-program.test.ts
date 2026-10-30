import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'

vi.mock('../preflight/workspace-agent-detection', () => ({
  onAgentsRefreshedOnHost: () => {}
}))
vi.mock('./structured-agent-launch-support', () => ({
  observeStructuredAgentLaunch: async () => null,
  resolveHostStructuredAgentLaunchEnvironment: async () => ({ PATH: '/usr/bin' })
}))
vi.mock('./structured-agent-shell-environment', () => ({
  recaptureHostShellEnvironment: async () => {}
}))
vi.mock('./structured-agent-runtime-metadata', () => ({
  STRUCTURED_AGENT_RUNTIME_METADATA: [
    {
      definition: { agent: 'zcode' },
      supportsLocation: () => true,
      chatProgram: {
        resolve: () => ({
          command: '/opt/ZCode/zcode',
          env: { ELECTRON_RUN_AS_NODE: '1' }
        })
      }
    }
  ]
}))

import { installStructuredAgentAvailability } from './structured-agent-availability'

it('publishes the Desktop app-server independently of terminal CLI inventory', async () => {
  const availability = installStructuredAgentAvailability(
    { onSettingsChanged: () => () => {} },
    {
      requireStore: () => ({ getSettings: () => getDefaultSettings('/home/test') })
    }
  )
  const read = vi.fn()
  availability.subscribe(read)
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  expect(read.mock.lastCall?.[0]).toEqual([
    { agent: 'zcode', state: 'available', chatProgram: 'available' }
  ])
})
