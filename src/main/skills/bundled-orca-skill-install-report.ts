import type { SkillInstallResult } from '../../shared/skill-install-contract'

export function describeSkillConflictReason(
  kind: NonNullable<SkillInstallResult['conflict']>['kind'] | undefined
): string {
  switch (kind) {
    case 'external-link':
      return 'the installed folder is a link Orca does not manage'
    case 'name-collision':
      return 'another file or folder already uses this name'
    case 'modified':
    case 'unowned':
    case undefined:
      return 'the installed copy has changes Orca did not make'
  }
}

/** One plain line per skill, shared by the update log and `orca skills install|update`. */
export function describeBundledSkillInstallResult(result: SkillInstallResult): string {
  const where = result.canonicalPath ? ` (${result.canonicalPath})` : ''
  switch (result.status) {
    case 'installed':
      return `${result.name}: installed${where}`
    case 'updated':
      return `${result.name}: updated${where}`
    case 'unchanged':
      return `${result.name}: already up to date${where}`
    case 'conflict':
      return `${result.name}: not changed, ${describeSkillConflictReason(result.conflict?.kind)}`
    case 'partial': {
      const missed = result.placements
        .filter((placement) => placement.status === 'failed' || placement.status === 'skipped')
        .map((placement) => placement.path)
      return `${result.name}: installed${where}, but not linked into ${missed.join(', ')}`
    }
    case 'cancelled':
      return `${result.name}: stopped`
    case 'failed':
    case 'removed':
      return `${result.name}: failed (${result.errorCategory ?? 'unknown error'})`
  }
}
