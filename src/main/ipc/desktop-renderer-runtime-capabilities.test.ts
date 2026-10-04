/**
 * The desktop renderer talks to two hosts — its own main process and a paired remote — and used to
 * advertise a different capability set to each, hand-maintained on both sides. `agent.launch` is
 * what that drift cost: admitted remotely, refused locally. These tests pin the divergence so the
 * next capability cannot be added to one side and forgotten on the other.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  SKILL_INSTALL_RESULT_V2_CAPABILITY,
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../shared/remote-runtime-client-capabilities'
import { supportsAgentLaunch } from '../runtime/rpc/methods/agent-launch'
import { createSupportFollowsHostSetting } from '../runtime/rpc/methods/structured-agent-session-policy'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'

// Every paired transport sends the shared base plus the Electron list, so compare the union.
const PAIRED_HOST_RECEIVES = remoteRuntimeClientCapabilities(
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
)

/** Advertised to a remote host and deliberately NOT to main: each would change local behaviour or
 *  has no local meaning. Adding to this set is a decision; leaving it out of both lists is not. */
const REMOTE_ONLY_BY_DECISION: readonly RuntimeCapability[] = [
  // Flips `requiresIntent` on, so an unattributed desktop tab close would start being refused.
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  // Carried as a group under one rationale, not audited one by one: these are mixed-version wire
  // terms, and main and the renderer are a single build. Before moving any of them across, check
  // what the host actually gates on it — the entry above is what that check looks like.
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  // Being a page host for a REMOTE runtime; main hosts its own pages directly.
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  // Opts into a delta feed in place of the full tab list — a remote-transport concern.
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  // Main marks `removing` on its own worktree IPC listings unconditionally; the renderer never
  // lists its own host's worktrees over runtime RPC, where this capability decides mark vs omit.
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY,
  // `skills.install` reaches a host only from main's remote install service, never over runtime:call.
  SKILL_INSTALL_RESULT_V2_CAPABILITY,
  // Unsettled, not a decision: the local tabs sync reads the census's `authoritative` label
  // (local-structured-session-tabs-sync/inventory-refresh.ts), which main drops without this.
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY
]

function missingFrom(
  source: readonly RuntimeCapability[],
  other: readonly RuntimeCapability[]
): RuntimeCapability[] {
  return source.filter((capability) => !other.includes(capability)).sort()
}

describe('desktop renderer runtime client capabilities', () => {
  it('passes the host gate that refuses agent.launch', () => {
    const renderer = {
      clientKind: 'runtime',
      clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
    } as const
    expect(supportsAgentLaunch(renderer)).toBe(true)
    // Negative control: the gate really discriminates, so the assertion above is not vacuous.
    expect(
      supportsAgentLaunch({
        clientKind: 'runtime',
        clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES.filter(
          (capability) => capability !== AGENT_LAUNCH_RUNTIME_CAPABILITY
        )
      })
    ).toBe(false)
  })

  // The desktop routes a launch on its own settings. A paired host answering createSupport from its
  // own setting would fail a chat the user asked for; main shares the desktop's setting, so locally
  // this only lets Retry on an existing chat relaunch after the setting is turned off.
  it.each([
    ['a paired host', PAIRED_HOST_RECEIVES],
    ['its own main process', DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]
  ] as const)('tells %s that it picks each launch mode itself', (_host, clientCapabilities) => {
    expect(createSupportFollowsHostSetting({ clientKind: 'runtime', clientCapabilities })).toBe(
      false
    )
  })

  it('diverges from what a paired host receives only where a decision was recorded', () => {
    expect(missingFrom(PAIRED_HOST_RECEIVES, DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES)).toEqual(
      [...REMOTE_ONLY_BY_DECISION].sort()
    )
    // The same renderer reads structured chats on either host, so it claims nothing only locally.
    expect(missingFrom(DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES, PAIRED_HOST_RECEIVES)).toEqual(
      []
    )
  })
})
