import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  inspectLaunchedAgentForeground,
  type ForegroundController,
  type MailboxAgentProcess,
  type MailboxForeground,
  type MailboxForegroundInspection
} from './launched-agent-foreground'

// Why: nothing reliably shows these agents returning after fg, so a hold could never release.
const HOLD_EXEMPT_AGENTS: ReadonlySet<string> = new Set<TuiAgent>(['pi', 'omp'])

/** A non-agent read, marked where mail must not hold: the host cannot name an agent (Windows, older relays),
 * or a title-only agent cannot show its return. */
export function unheldForeground(
  foreground: MailboxForeground,
  agentUnprovable: boolean,
  expected: TuiAgent | undefined
): MailboxForegroundInspection {
  if (agentUnprovable) {
    return { foreground, agentUnprovable: true }
  }
  return isHoldExemptAgent(expected) ? { foreground, holdExempt: true } : { foreground }
}

export function isHoldExemptAgent(agent: string | null | undefined): boolean {
  return !!agent && HOLD_EXEMPT_AGENTS.has(agent)
}

export async function readMailboxForeground(
  controller: ForegroundController,
  host: { remote: boolean; windows: boolean },
  ptyId: string,
  expected?: TuiAgent,
  expectedIncarnationId?: string,
  adoptedRootPid?: number | null
): Promise<MailboxForegroundInspection> {
  let agent: TuiAgent | undefined
  let process: MailboxAgentProcess | undefined
  let unprovable = false
  const foreground = await inspectLaunchedAgentForeground(
    controller,
    host,
    ptyId,
    expected,
    expectedIncarnationId,
    undefined,
    true,
    (value, row) => {
      agent = value
      process = row
    },
    adoptedRootPid,
    () => {
      // Why: a relay that sends no evidence (older versions) can never name the agent for mail.
      unprovable = true
    }
  )
  if (foreground === 'agent') {
    return { foreground, agent: agent ?? expected, ...(process ? { process } : {}) }
  }
  return unheldForeground(foreground, host.windows || unprovable, expected)
}
