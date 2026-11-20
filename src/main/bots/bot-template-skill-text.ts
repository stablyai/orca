// Our own SKILL.md for each template skill, written into a template bot's home.
import type { BotTemplateSkill } from '../../shared/bots/bot-templates'
import { SKILL as bugReproduction } from './bot-template-skills/bug-reproduction'
import { SKILL as ciFailureTriage } from './bot-template-skills/ci-failure-triage'
import { SKILL as dependencyUpgrade } from './bot-template-skills/dependency-upgrade'
import { SKILL as feedbackThemes } from './bot-template-skills/feedback-themes'
import { SKILL as incidentTimeline } from './bot-template-skills/incident-timeline'
import { SKILL as issueTriage } from './bot-template-skills/issue-triage'
import { SKILL as prReviewChecklist } from './bot-template-skills/pr-review-checklist'
import { SKILL as releaseNotesStyle } from './bot-template-skills/release-notes-style'
import { SKILL as releaseReadiness } from './bot-template-skills/release-readiness'
import { SKILL as securityChecklist } from './bot-template-skills/security-checklist'
import { SKILL as specFormat } from './bot-template-skills/spec-format'
import { SKILL as statusBrief } from './bot-template-skills/status-brief'
import { SKILL as workspaceHygiene } from './bot-template-skills/workspace-hygiene'

export const BOT_TEMPLATE_SKILL_TEXT: Record<BotTemplateSkill, string> = {
  'bug-reproduction': bugReproduction,
  'ci-failure-triage': ciFailureTriage,
  'dependency-upgrade': dependencyUpgrade,
  'feedback-themes': feedbackThemes,
  'incident-timeline': incidentTimeline,
  'issue-triage': issueTriage,
  'pr-review-checklist': prReviewChecklist,
  'release-notes-style': releaseNotesStyle,
  'release-readiness': releaseReadiness,
  'security-checklist': securityChecklist,
  'spec-format': specFormat,
  'status-brief': statusBrief,
  'workspace-hygiene': workspaceHygiene
}
