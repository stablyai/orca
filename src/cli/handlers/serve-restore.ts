import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import type {
  AutomaticWorkMode,
  AutomaticWorkResumeResult,
  LegacyRestoreRecord
} from '../../shared/host-spawn-admission'

type AutomaticWorkResumeResponse = {
  automaticWork: AutomaticWorkResumeResult | null
  terminalHostPredatesResume?: true
}

const PAUSE_REASONS: Record<Extract<AutomaticWorkMode, { kind: 'paused' }>['reason'], string> = {
  unclean_host_death: 'the terminal host stopped unexpectedly',
  pressure: 'the host was under heavy process load',
  operator: 'an operator paused them'
}

const LEGACY_RESTORE_REASONS: Record<LegacyRestoreRecord['reason'], string> = {
  pressure: 'the host was under heavy process load',
  host_cap: 'the host had reached its terminal limit'
}

function formatLegacyRestores(records: readonly LegacyRestoreRecord[] | undefined): string {
  if (!records?.length) {
    return ''
  }
  const lines = records.map((record) => {
    const where = record.cwd ? ` in ${record.cwd}` : ''
    const when = new Date(record.refusedAt).toISOString()
    const resume = record.command
      ? `Resume it with: ${record.command}`
      : 'Its resume command was not recorded.'
    return `- ${record.agent ?? 'an agent'}${where}, refused ${when} (${LEGACY_RESTORE_REASONS[record.reason]}). ${resume}`
  })
  const count = records.length === 1 ? '1 restore' : `${records.length} restores`
  return [
    '',
    '',
    `This host refused ${count} from an older Orca client and kept them here:`,
    ...lines
  ].join('\n')
}

export function formatAutomaticWorkResume(result: AutomaticWorkResumeResponse): string {
  const message = formatAutomaticWorkResumeMessage(result)
  return `${message}${formatLegacyRestores(result.automaticWork?.legacyRestores)}`
}

function formatAutomaticWorkResumeMessage(result: AutomaticWorkResumeResponse): string {
  const automaticWork = result.automaticWork
  if (result.terminalHostPredatesResume) {
    return 'The terminal host running now predates this command, so it cannot clear its pause. Run this again after the terminal host restarts. Until then, opening a sleeping terminal still resumes it.'
  }
  if (!automaticWork) {
    return 'This host has no automatic-restore gate to resume (its terminal host predates it).'
  }
  if (!automaticWork.cleared || automaticWork.cleared.kind !== 'paused') {
    return 'Automatic restores were not paused; nothing to resume.'
  }
  const since = new Date(automaticWork.cleared.since).toISOString()
  return `Automatic restores resumed. They were paused at ${since} because ${PAUSE_REASONS[automaticWork.cleared.reason]}.`
}

export const SERVE_RESTORE_HANDLERS: Record<string, CommandHandler> = {
  'serve restore resume': async ({ client, json }) => {
    const response = await client.call<AutomaticWorkResumeResponse>('runtime.automaticWork.resume')
    printResult(response, json, formatAutomaticWorkResume)
  }
}
