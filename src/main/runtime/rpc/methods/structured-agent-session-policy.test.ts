import { describe, expect, it } from 'vitest'
import {
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  createSupportFollowsHostSetting,
  structuredAgentsReadBy,
  clientRendersStructuredAgent,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'
import { parseRuntimeClientCapabilities } from '../runtime-client-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/web-runtime-client-capabilities'

const CAPABLE = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]

describe('Pi audience in a registered-agents client', () => {
  const registered = [...CAPABLE, STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY]

  it('keeps Pi out of tab and restart audiences until the dialog shape is advertised', () => {
    expect(clientRendersStructuredAgent(registered, 'pi')).toBe(false)
    expect(clientRendersStructuredAgent(registered, 'grok')).toBe(true)
    const audience = structuredAgentsReadBy(
      { clientKind: 'runtime', clientCapabilities: registered },
      ['codex', 'grok', 'pi']
    )
    expect(audience?.('pi')).toBe(false)
    expect(audience?.('grok')).toBe(true)
    expect(
      structuredAgentsReadBy(
        {
          clientKind: 'runtime',
          clientCapabilities: [...registered, PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY]
        },
        ['codex', 'grok', 'pi']
      )
    ).toBeUndefined()
  })
})

describe('supportsStructuredAgentSessions', () => {
  it.each(['runtime', 'mobile'] as const)(
    'admits a %s client that advertises the capability',
    (clientKind) => {
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: CAPABLE })).toBe(
        true
      )
    }
  )

  it('admits a capability-less in-process caller, which negotiates nothing', () => {
    expect(
      supportsStructuredAgentSessions({ clientKind: undefined, clientCapabilities: undefined })
    ).toBe(true)
  })

  it.each(['runtime', 'mobile'] as const)(
    'refuses a %s client that did not advertise the capability',
    (clientKind) => {
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: [] })).toBe(false)
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: undefined })).toBe(
        false
      )
    }
  )
})

describe('createSupportFollowsHostSetting', () => {
  it.each(['runtime', 'mobile'] as const)(
    'leaves a %s client that picks its own launch mode to capability alone',
    (clientKind) => {
      expect(
        createSupportFollowsHostSetting({
          clientKind,
          clientCapabilities: [...CAPABLE, STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY]
        })
      ).toBe(false)
    }
  )

  it.each(['runtime', 'mobile'] as const)(
    'answers a %s client that leaves the mode to the host with the host setting',
    (clientKind) => {
      expect(createSupportFollowsHostSetting({ clientKind, clientCapabilities: CAPABLE })).toBe(
        true
      )
    }
  )

  it('leaves an in-process caller, the same build as the host, to capability alone', () => {
    expect(
      createSupportFollowsHostSetting({ clientKind: undefined, clientCapabilities: undefined })
    ).toBe(false)
  })
})

// Both run the same chat; the browser client once omitted the structured capability and every
// chat was refused (#32145).
describe.each([
  ['browser client', WEB_RUNTIME_CLIENT_CAPABILITIES],
  ['desktop', remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)]
])("this build's %s handshake, as a paired host parses it", (_client, advertised) => {
  const clientCapabilities = parseRuntimeClientCapabilities([...advertised])
  const context = { clientKind: 'runtime' as const, clientCapabilities }

  it('is kept whole and admits structured sessions', () => {
    expect(clientCapabilities).toEqual(advertised)
    expect(supportsStructuredAgentSessions(context)).toBe(true)
    expect(createSupportFollowsHostSetting(context)).toBe(false)
  })

  it.each(['claude', 'codex', 'pi', 'opencode'])('renders %s chats', (agent) => {
    expect(clientRendersStructuredAgent(clientCapabilities, agent)).toBe(true)
  })
})
