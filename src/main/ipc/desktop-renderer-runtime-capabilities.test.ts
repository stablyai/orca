/**
 * The desktop renderer talks to two hosts — its own main process and a paired remote — and used to
 * advertise a different capability set to each, hand-maintained on both sides. `agent.launch` is
 * what that drift cost: admitted remotely, refused locally. These tests pin the divergence so the
 * next capability cannot be added to one side and forgotten on the other.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import { supportsAgentLaunch } from '../runtime/rpc/methods/agent-launch'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'

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
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY
]

/** Gates the renderer must pass against its own main process. The Electron remote list omits all
 *  six; mobile advertises the structured ones, so this is an Electron-remote gap rather than a
 *  statement that no remote client wants them. Why it is one is not recorded here. */
const LOCAL_ONLY_BY_DECISION: readonly RuntimeCapability[] = [
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
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

  it('advertises each capability once so none can be dropped by a stale duplicate', () => {
    expect(new Set(DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES).size).toBe(
      DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES.length
    )
  })

  it('diverges from the remote Electron list only where a decision was recorded', () => {
    expect(
      missingFrom(
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
        DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
      )
    ).toEqual([...REMOTE_ONLY_BY_DECISION].sort())
    expect(
      missingFrom(
        DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
    ).toEqual([...LOCAL_ONLY_BY_DECISION].sort())
  })
})
