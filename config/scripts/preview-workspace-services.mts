/**
 * Preview the services the panel will show, from a terminal.
 *
 * Exists so the detection layer can be inspected against a real machine before
 * (and independently of) the renderer wiring. Run with:
 *   npx tsx config/scripts/preview-workspace-services.mts
 */
import process from 'node:process'
import { scanWorkspaceServices } from '../../src/main/ports/workspace-service-scan'
import type { WorkspaceService } from '../../src/shared/workspace-services'

const DASH = '—'

function cell(value: string | null, width: number): string {
  const text = value ?? DASH
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text
  return clipped.padEnd(width)
}

function renderGroup(title: string, services: WorkspaceService[]): void {
  if (services.length === 0) {
    return
  }
  console.log(`\n${title}`)
  console.log(
    `${cell('PORT', 7)}${cell('SERVICE', 24)}${cell('COMMAND', 26)}${cell('PROJECT', 22)}STARTED BY`
  )
  console.log('-'.repeat(96))
  for (const service of services) {
    const columns = `${cell(String(service.port), 7)}${cell(service.serviceName, 24)}${cell(
      service.launchCommand,
      26
    )}${cell(service.projectName, 22)}`
    console.log(`${columns}${service.launchedByAgent ?? DASH}`)
  }
}

async function main(): Promise<void> {
  const result = await scanWorkspaceServices([])

  renderGroup(
    'LOCAL PROCESSES',
    result.services.filter((service) => service.kind === 'process' && !service.isOrphan)
  )
  renderGroup(
    'DOCKER CONTAINERS',
    result.services.filter((service) => service.kind === 'container' && !service.isOrphan)
  )
  renderGroup(
    'ORPHANS (workspace deleted, service still running)',
    result.services.filter((service) => service.isOrphan)
  )

  const processes = result.services.filter((service) => service.kind === 'process').length
  const containers = result.services.length - processes
  const suffix = result.dockerAvailable
    ? ''
    : ` (${result.dockerUnavailableReason ?? 'docker unavailable'})`
  console.log(`\n${processes} local · ${containers} docker${suffix}`)
  if (result.unavailableReason) {
    console.log(result.unavailableReason)
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
