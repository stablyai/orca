// The stand-in's Linear writes: `set` on an issue, and a post with a title making one, each reading
// every name first as linear-issue-fields.ts does, so nothing changes when one doesn't fit.
// bot-automation-eval-linear.test.ts holds both to the cloud's recorded answers.
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import {
  applied,
  factsOf,
  issueRef,
  linearIssues,
  teamOf,
  type LinearChange,
  type LinearIssue,
  type LinearRun
} from './bot-automation-eval-linear'
import {
  LINEAR_PRIORITY_NUMBERS,
  linearIssueIdFor,
  linearLabelsClash,
  linearNamed,
  onlyOneLinearNamed
} from '../../../cloud/packages/connector-contract/src/linear-issue-names'
import { lookUp, refuse, type Refused } from './bot-automation-eval-linear-names'
import WORLD from './bot-automation-eval-linear-world.json'

type Fields = NonNullable<ConnectorActionArgs['fields']>
type Team = (typeof WORLD.teams)[number]

const personNamed = (kind: 'person' | 'agent', name: string) =>
  onlyOneLinearNamed(
    kind,
    name,
    // The world's members are all people; no app takes delegated issues.
    lookUp(kind, kind === 'person' ? WORLD.members : [], name, (member) => [
      member.name,
      member.displayName
    ])
  )

/** The fields' names read as the issue's team reads them, or the first that names nothing. */
function namedFields(
  fields: Fields
): (LinearChange & { added: string[]; removed: string[] }) | Refused {
  const { state, assignee, delegate, priority, addLabels, removeLabels, estimate } = fields
  const clash = linearLabelsClash(addLabels, removeLabels)
  if (clash) {
    return clash
  }
  const labels = WORLD.labels.map((name) => ({ name }))
  const stateFound =
    state === undefined
      ? null
      : onlyOneLinearNamed('state', state, linearNamed('state', WORLD.states, state))
  const assigneeFound = assignee ? personNamed('person', assignee) : null
  const delegateFound = delegate ? personNamed('agent', delegate) : null
  const labelsFound = [...(addLabels ?? []), ...(removeLabels ?? [])].map((name) =>
    onlyOneLinearNamed('label', name, lookUp('label', labels, name))
  )
  // The first that names nothing, in the cloud's order.
  const refused = [stateFound, assigneeFound, delegateFound, ...labelsFound].find(
    (found): found is Refused => found !== null && 'ok' in found
  )
  if (refused) {
    return refused
  }
  const named = (found: { name: string } | Refused) => ('ok' in found ? '' : found.name)
  return {
    ...(stateFound && !('ok' in stateFound) ? { state: stateFound.name } : {}),
    ...(assignee === null
      ? { assignee: null }
      : assigneeFound && !('ok' in assigneeFound)
        ? { assignee: assigneeFound.id }
        : {}),
    ...(priority === undefined ? {} : { priority: LINEAR_PRIORITY_NUMBERS[priority] }),
    ...(estimate === undefined ? {} : { estimate }),
    added: labelsFound.slice(0, addLabels?.length ?? 0).map(named),
    removed: labelsFound.slice(addLabels?.length ?? 0).map(named)
  }
}

/** An issue's fields set by name, all or none, as linear-issue-set.ts does: the answer, and what changed. */
export function setLinear(issue: LinearIssue, fields: Fields, run?: LinearRun) {
  const named = namedFields(fields)
  if ('ok' in named) {
    return { answer: named }
  }
  const { added, removed, ...rest } = named
  const change: LinearChange = {
    ...rest,
    labels: [
      ...issue.labels.filter((label) => !removed.includes(label)),
      ...added.filter((label) => !issue.labels.includes(label))
    ]
  }
  return {
    answer: {
      ok: true as const,
      result: {
        target: { ref: issueRef(issue), label: `${issue.identifier} ${issue.title}` },
        facts: factsOf(applied(issue, change), linearIssues(run))
      }
    },
    change
  }
}

/** A made issue as the post's answer, as linear-issue-create.ts gives it. */
const createdAnswer = (made: LinearIssue, issues: readonly LinearIssue[]) => ({
  ok: true as const,
  result: {
    created: true,
    target: { ref: issueRef(made), label: `${made.identifier} ${made.title}` },
    facts: factsOf(made, issues)
  }
})

/** A new issue in a team, as linear-issue-create.ts makes one: the answer, and the issue made. A
 *  retry of the same post answers with the issue it already made. */
export function createLinear(
  team: Team,
  issue: { key: string; title: string; text?: string; parent?: LinearIssue; fields?: Fields },
  run: LinearRun = {}
) {
  const id = linearIssueIdFor(issue.key)
  const issues = linearIssues(run)
  const earlier = issues.find((entry) => entry.id === id)
  if (earlier) {
    return { answer: createdAnswer(earlier, issues) }
  }
  if (issue.fields?.removeLabels) {
    return { answer: refuse('invalid_args', 'A new issue has no labels to remove.') }
  }
  const named = namedFields(issue.fields ?? {})
  if ('ok' in named) {
    return { answer: named }
  }
  const { added, removed: _removed, assignee, estimate, ...rest } = named
  const numbers = issues.flatMap((entry) =>
    teamOf(entry) === team ? [Number(entry.identifier.split('-')[1])] : []
  )
  const made: LinearIssue = {
    id,
    identifier: `${team.key}-${Math.max(0, ...numbers) + 1}`,
    title: issue.title,
    ...(issue.text ? { description: issue.text } : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // A new issue starts in the team's first state (Triage) unless the post names one.
    state: WORLD.states[0]!.name,
    priority: 0,
    ...rest,
    ...(assignee ? { assignee } : {}),
    ...(estimate === null || estimate === undefined ? {} : { estimate }),
    ...(issue.parent ? { parent: issue.parent.id } : {}),
    labels: added
  }
  return { answer: createdAnswer(made, [...issues, made]), made }
}
