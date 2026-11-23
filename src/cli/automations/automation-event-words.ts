// What each source's events and filters are, in words, for trigger-options and a rule's description.
import type {
  AUTOMATION_EVENT_KINDS,
  AutomationConnectorEventTrigger,
  AutomationEventSource
} from '../../shared/automation-event-triggers'

import { workflowWaitRecipe } from '../../shared/automation-workflow-wait-recipe'

type ConnectorEventSource = AutomationConnectorEventTrigger['source']

type EventWords = {
  [Source in AutomationEventSource]: Record<(typeof AUTOMATION_EVENT_KINDS)[Source][number], string>
}

// "You" is the bot's owner; anyone in the place may set one off, unless from= names people.
export const EVENT_WORDS: EventWords = {
  slack: {
    mentioned: 'your owner is mentioned in a channel the bot is in',
    message: 'a new message is posted in a channel the bot is in',
    reaction: 'someone reacts to a message in a channel the bot is in'
  },
  github: {
    issue_opened: 'an issue is opened',
    pr_opened: 'a pull request is opened',
    pr_pushed: 'new commits are pushed to an open pull request',
    pr_merged: 'a pull request is merged',
    comment: 'someone comments on an issue or pull request',
    review_comment: "someone comments on a pull request's diff",
    review: 'a pull request review is submitted',
    mentioned: 'your owner is mentioned in a comment or review',
    review_requested: 'your review is requested',
    assigned: "you're assigned an issue or pull request",
    ci_failed:
      "a check, commit status or workflow run finishes without passing: failed, cancelled, timed out or waiting for approval all count (once per commit, on the first; the event names it and how it ended). With subject=, on that pull request's latest commit; without, on any commit, a branch push's or a dispatched run's too",
    ci_passed:
      "every check and commit status on a pull request's latest commit has finished and each passed, was skipped or was neutral (once per commit)",
    ci_finished:
      "every check and commit status on a pull request's latest commit has finished, whatever the result (once per commit); the event says result=passed or result=failed and names each check that did not pass and how it ended, or result=pending if CI is still running 6 hours after the push",
    pr_conflicted: 'a pull request gets merge conflicts with its base branch',
    pr_closed: 'a pull request is closed without merging',
    pr_ready: 'a draft pull request is marked ready for review',
    labeled: 'an issue or pull request is given a label',
    issue_closed: 'an issue is closed',
    deploy_finished: 'a deployment finishes (succeeds or fails)',
    security_alert: 'a Dependabot, code scanning or secret scanning alert is opened',
    workflow_finished:
      'the one GitHub Actions run that run= names finishes, whatever its result (its reserved result token is [conclusion=failure] for a failure)'
  },
  linear: {
    assigned: "you're assigned an issue in Linear",
    mentioned: 'your owner is mentioned in a Linear comment',
    issue_created: 'a Linear issue is created',
    issue_moved: 'a Linear issue moves to another status'
  },
  webhook: { call: "the automation's webhook URL is called" },
  gmail: { new_email: 'a new email arrives' },
  calendar: { starting_soon: 'an event on your calendar starts soon' }
}

// What a source never starts on, so the bot can say so when it confirms a trigger.
export const SOURCE_NOTES: Partial<Record<AutomationEventSource, string>> = {
  slack:
    "slack.message counts only top-level posts, unless subject= names a thread: then each reply in that thread counts too. A reaction's text is its emoji, as :eyes:. A message from Slack writes a channel as <#C0123ABCD|name>; in= takes that id or the #name. A message that @-mentions the bot, or a DM to it, asks the bot directly; that needs no automation.",
  github:
    "Only repos where the Orca GitHub app is installed. Your own pushes, comments, reviews and labels start nothing (the bot works as you), except CI results, a pull request's merge, close or conflicts, deployments, security alerts and finished workflow runs, and a pull request you open when from= names me; one your bot's own work opens as you never does. A comment that @-mentions the bot asks it directly instead. ci_passed, ci_finished and pr_conflicted follow one pull request, so they need subject=. ci_passed and ci_finished never fire on a repo with no CI checks. A conflict from a direct push to the base branch is noticed at the next merge or CI run on it.",
  linear:
    'Only workspaces where the Orca Linear app is installed. Your own changes and comments start nothing (the bot can work as you); a comment that @-mentions Orca asks the bot directly instead.'
}

/** How a bot waits on a GitHub Actions run it started, where its Orca Cloud sends workflow_finished. */
export const WORKFLOW_WAIT_RECIPE = workflowWaitRecipe('orca')

export const PLACE_WORDS: Record<ConnectorEventSource, string> = {
  slack: 'Slack channels: a #name, a pasted channel link, a channel id (C0123ABCD) or a ref',
  github: 'repos: owner/name, a link or a ref',
  linear:
    'Linear teams or whole workspaces: a team key (ENG), a team or workspace name, or a ref from `orca bot connectors`'
}

export const SUBJECT_WORDS: Record<ConnectorEventSource, string> = {
  slack: 'one thread: a pasted message link or a ref',
  github: 'one issue or pull request: owner/name#482, a link or a ref',
  linear: 'one issue: ENG-123, a link or a ref'
}
