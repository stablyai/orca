import type { SkillInstallDestination } from '../../shared/skill-install-contract'

/** Relay hosts resolve a global destination locally; remote clients must not receive host metadata. */
export function normalizeSshRelaySkillDestination(
  destination: SkillInstallDestination
): SkillInstallDestination {
  return destination.scope === 'global'
    ? { scope: 'global', executionTarget: { kind: 'host' } }
    : destination
}
