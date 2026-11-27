import { describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { structuredAgentRuntimeMetadata } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'

describe('DSH_LAUNCH_SPEC', () => {
  it('registers dsh as an ACP structured chat agent', () => {
    const spec = acpLaunchSpecFor('dsh')
    expect(spec).not.toBeNull()
    expect(spec?.command).toBe('dsh')
    expect(spec?.args({ fullAccess: false, pluginDirs: [] })).toEqual(['--profile', 'acp'])
    expect(spec?.ignoreAgentCommandSetting).toBe(true)

    const metadata = structuredAgentRuntimeMetadata('dsh')
    expect(metadata).not.toBeNull()
    expect(metadata?.definition.agent).toBe('dsh')
  })
})
