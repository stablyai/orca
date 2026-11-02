import { AUTOMATION_ORPHAN_ISSUES as EN } from '../../../src/shared/automation-list-scope'
import { translate } from '../i18n/mobile-i18n'

const COPY: Record<string, () => string> = {
  [EN.targetMissing]: () => translate('automations.orphanIssues.targetMissing', EN.targetMissing),
  [EN.targetReplaced]: () =>
    translate('automations.orphanIssues.targetReplaced', EN.targetReplaced),
  [EN.scheduledElsewhere]: () =>
    translate('automations.orphanIssues.scheduledElsewhere', EN.scheduledElsewhere),
  [EN.projectMissing]: () =>
    translate('automations.orphanIssues.projectMissing', EN.projectMissing),
  [EN.projectUnverified]: () =>
    translate('automations.orphanIssues.projectUnverified', EN.projectUnverified),
  [EN.workspaceHostAmbiguous]: () =>
    translate('automations.orphanIssues.workspaceHostAmbiguous', EN.workspaceHostAmbiguous),
  [EN.malformed]: () => translate('automations.orphanIssues.malformed', EN.malformed),
  [EN.hostReselection]: () =>
    translate('automations.orphanIssues.hostReselection', EN.hostReselection)
}

/** Unknown host reasons keep their original text across mixed client/server versions. */
export function automationOrphanIssueText(issue: string): string {
  return Object.hasOwn(COPY, issue) ? COPY[issue]() : issue
}
