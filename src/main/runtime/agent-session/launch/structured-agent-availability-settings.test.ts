import { expect, it, vi } from 'vitest'

vi.mock('../installation/structured-agent-runtime-metadata', () => ({
  STRUCTURED_AGENT_RUNTIME_METADATA: [],
  structuredAgentRuntimeMetadata: () => undefined
}))
vi.mock('../environment/structured-agent-shell-environment', () => ({
  recaptureHostShellEnvironment: async () => undefined
}))
vi.mock('../../../acp/launch/acp-launch-registry', () => ({ ACP_LAUNCH_SPECS: [] }))

import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { installStructuredAgentAvailability } from './structured-agent-availability'

it('derives availability again when the Google sign-in choice changes where new chats run', async () => {
  let changed: ((updates: Partial<GlobalSettings>) => void) | undefined
  const store: Pick<RuntimeStore, 'onSettingsChanged'> = {
    onSettingsChanged: (listener) => {
      changed = (updates) => listener(updates, getDefaultSettings('/home/u'))
      return () => undefined
    }
  }
  const runtime = { requireStore: () => ({ getSettings: () => ({}) }) }
  const reads = vi.fn()
  installStructuredAgentAvailability(store, runtime).subscribe(reads)
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1))

  changed?.({ antigravityGoogleSignIn: 'orca' })
  await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2))
})
