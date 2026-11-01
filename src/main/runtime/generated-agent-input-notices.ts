import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import type { GeneratedAgentInputNotice } from '../../shared/generated-agent-input-notice'

/** These records are the notices, retained for this runtime session until explicit dismissal. */
export class GeneratedAgentInputNotices {
  private readonly notices = new Map<string, GeneratedAgentInputNotice>()

  constructor(private readonly changed: (notices: GeneratedAgentInputNotice[]) => void) {}

  snapshot(): GeneratedAgentInputNotice[] {
    return [...this.notices.values()]
  }

  add(notice: Omit<GeneratedAgentInputNotice, 'id'>): void {
    const id = randomUUID()
    this.notices.set(id, { ...notice, id })
    this.changed(this.snapshot())
  }

  recovery(
    notice: Omit<GeneratedAgentInputNotice, 'id' | 'certainty'>
  ): (certainty: GeneratedAgentInputNotice['certainty']) => void {
    let recovered = false
    return (certainty) => {
      if (recovered) {
        return
      }
      recovered = true
      this.add({ ...notice, certainty })
    }
  }

  dismiss(id: string): void {
    if (this.notices.delete(id)) {
      this.changed(this.snapshot())
    }
  }
}

export function captureGeneratedInputRecovery(
  runtime: Pick<
    OrcaRuntimeService,
    'generatedInputNotices' | 'getTerminalPtyIdForHandle' | 'getTerminalWorktreeIdForHandle'
  >,
  handle: string,
  agent: GeneratedAgentInputNotice['agent'],
  text: string
): (certainty: GeneratedAgentInputNotice['certainty']) => void {
  return runtime.generatedInputNotices.recovery({
    handle,
    agent,
    text,
    ptyId: runtime.getTerminalPtyIdForHandle(handle),
    worktreeId: runtime.getTerminalWorktreeIdForHandle(handle) ?? ''
  })
}
