import type {
  AgentLaunchNotice,
  AgentLaunchNoticeCode
} from '../../../src/shared/agent-launch-contract'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'

// snapshot_definition_changed is informational and renders as a quiet chip; the
// fallback and env-withheld notices are durable banner-tier warnings. Mirrors the
// desktop AgentLaunchNotices tiering so both surfaces stay honest in lockstep.
const CHIP_TIER_NOTICE_CODES: ReadonlySet<AgentLaunchNoticeCode> = new Set([
  'snapshot_definition_changed'
])

export type MobileLaunchNoticeTier = 'banner' | 'chip'

export function mobileLaunchNoticeTier(notice: AgentLaunchNotice): MobileLaunchNoticeTier {
  return CHIP_TIER_NOTICE_CODES.has(notice.code) ? 'chip' : 'banner'
}

// Plain-string mobile copy (mobile does not use the localization catalog). Honest
// per-code text; the base label comes from the mobile-local built-in table rather
// than a runtime import of the desktop display-name module, which can break the
// mobile Vitest transform.
export function resolveMobileLaunchNoticeText(notice: AgentLaunchNotice): string {
  switch (notice.code) {
    case 'disabled_custom_fallback':
      return `${notice.label} is disabled. Started stock ${MOBILE_TUI_AGENT_LABELS[notice.baseAgent]} with no custom executable, custom arguments, or custom agent environment.`
    case 'missing_custom_fallback':
      return `${notice.label} was deleted. Started stock ${MOBILE_TUI_AGENT_LABELS[notice.baseAgent]} with no custom executable, custom arguments, or custom agent environment.`
    case 'env_withheld':
      return `This launch didn't use all of ${notice.label}'s environment values. Manage paired-launch env on the desktop host.`
    case 'snapshot_definition_changed':
      return 'Resumed with the settings saved when this session started.'
    case 'vault_original_config_unavailable':
      return `Original launch settings weren't available. Resumed with current ${MOBILE_TUI_AGENT_LABELS[notice.baseAgent]} settings.`
  }
}
