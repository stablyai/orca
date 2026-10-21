import { SERVE_GAVE_UP_ADVICE } from '../runtime/serve-supervisor-brake'
import type { ServeServiceStatus } from './serve-service'

export function formatServeServiceInstall(result: Record<string, unknown>): string {
  if (result.dryRun) {
    return `Would write ${String(result.unitPath)}:\n\n${String(result.content)}`
  }
  const lines = [
    `Installed ${String(result.name)} (${String(result.manager)}) at ${String(result.unitPath)}.`
  ]
  if (result.logPath) {
    lines.push(`Log: ${String(result.logPath)}`)
  }
  if (result.linger === 'no') {
    lines.push(
      'Note: lingering is off for this user, so the service stops when you log out. Run `loginctl enable-linger` to keep it running.'
    )
  }
  lines.push(
    'Pairing is off in the service; pair clients with `orca serve` in a terminal or from the desktop app.'
  )
  return lines.join('\n')
}

export function formatServeServiceStatus(status: ServeServiceStatus): string {
  if (!status.installed && status.verdict !== 'live') {
    return `${status.name} is not installed. Run \`orca serve service install\`.`
  }
  const lines = [
    `${status.name} (${status.manager}): ${status.verdict}${status.pid ? `, pid ${status.pid}` : ''} — ${status.detail}`,
    `Unit: ${status.unitPath}${status.installed ? '' : ' (missing)'}`
  ]
  if (status.gaveUp) {
    lines.push(`Gave up: ${status.gaveUp} ${SERVE_GAVE_UP_ADVICE}`)
  }
  return lines.join('\n')
}
