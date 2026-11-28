import { AUTOMATION_ORPHAN_ISSUES as EN } from '../../../src/shared/automations/ownership/automation-list-scope'
import type { Translate } from '../i18n/mobile-i18n'

const COPY: Record<string, (t: Translate) => string> = {
  [EN.targetMissing]: (t) => t('automations.orphanIssues.targetMissing', EN.targetMissing),
  [EN.targetReplaced]: (t) => t('automations.orphanIssues.targetReplaced', EN.targetReplaced),
  [EN.scheduledElsewhere]: (t) =>
    t('automations.orphanIssues.scheduledElsewhere', EN.scheduledElsewhere),
  [EN.projectMissing]: (t) => t('automations.orphanIssues.projectMissing', EN.projectMissing),
  [EN.projectUnverified]: (t) =>
    t('automations.orphanIssues.projectUnverified', EN.projectUnverified),
  [EN.workspaceHostAmbiguous]: (t) =>
    t('automations.orphanIssues.workspaceHostAmbiguous', EN.workspaceHostAmbiguous),
  [EN.malformed]: (t) => t('automations.orphanIssues.malformed', EN.malformed),
  [EN.hostReselection]: (t) => t('automations.orphanIssues.hostReselection', EN.hostReselection)
}

/** Unknown host reasons keep their original text across mixed client/server versions. */
export function automationOrphanIssueText(issue: string, t: Translate): string {
  return Object.hasOwn(COPY, issue) ? COPY[issue](t) : issue
}
