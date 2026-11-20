import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { MailboxForeground, MailboxForegroundInspection } from './launched-agent-foreground'

// Why: nothing reliably shows these agents returning after fg, so a hold could never release.
const HOLD_EXEMPT_AGENTS: ReadonlySet<TuiAgent> = new Set(['pi', 'omp'])

/** A non-agent read, marked where mail must not hold: Windows can neither name an agent nor suspend one
 * behind another program, and title-only agents cannot show their return. */
export function unheldForeground(
  foreground: MailboxForeground,
  windows: boolean,
  expected: TuiAgent | undefined
): MailboxForegroundInspection {
  if (windows) {
    return { foreground, agentUnprovable: true }
  }
  return expected && HOLD_EXEMPT_AGENTS.has(expected)
    ? { foreground, holdExempt: true }
    : { foreground }
}
