import { orcadRestartWorkAdmission } from '../../orcad/orcad-restart-work-admission'
import { refuse } from '../../../shared/agent-session-wire'

export function structuredAgentSessionRestartRefusal() {
  return !orcadRestartWorkAdmission.allowWork()
    ? { ok: false as const, refusal: refuse('execution_owner_reconciling', { reason: 'hostReconciling' }, 'The Orca server is updating. Retry when it reconnects.') }
    : null
}
