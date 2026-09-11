// What this desktop tells a paired host it can read, and the one lever that takes it back.
//
// The structured reader strings are not inert: a host withholds structured session-tab rows and
// refuses `agentSession.*` to a client that omits them, so advertising them is what makes a paired
// host start publishing other machines' chats here. That is a change to published content, which
// the wire contract treats as a wire change, so it needs a retreat that does not require shipping
// a new build. Every connection this process opens reads the list from here.
//
// The lever is read through a source rather than mirrored, because a stale copy would advertise on
// behalf of a user who had already switched it off. It only reaches connections opened after the
// switch: a capability is negotiated once per connection, so an established pairing keeps reading
// until it reconnects.

import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_READER_RUNTIME_CAPABILITIES,
  type RuntimeCapability
} from '../../shared/protocol-version'

const READER_CAPABILITIES = new Set<string>(STRUCTURED_AGENT_SESSION_READER_RUNTIME_CAPABILITIES)

const WITHOUT_STRUCTURED_READER: readonly RuntimeCapability[] =
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES.filter(
    (capability) => !READER_CAPABILITIES.has(capability)
  )

/** Absent source = advertise, matching every other capability this build ships with. */
let readStructuredChatRemoteRead: (() => boolean) | null = null

export function setStructuredChatRemoteReadSource(source: () => boolean): void {
  readStructuredChatRemoteRead = source
}

export function resetStructuredChatRemoteReadSourceForTests(): void {
  readStructuredChatRemoteRead = null
}

export function structuredChatRemoteReadEnabled(): boolean {
  try {
    return readStructuredChatRemoteRead?.() !== false
  } catch {
    // A settings read that throws must not silently retreat a feature the user left on.
    return true
  }
}

export function electronRemoteRuntimeClientCapabilities(): readonly RuntimeCapability[] {
  return structuredChatRemoteReadEnabled()
    ? ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    : WITHOUT_STRUCTURED_READER
}
