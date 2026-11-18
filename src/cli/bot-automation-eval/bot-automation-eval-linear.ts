// The stand-in's Linear workspace: one world every scenario shares (bot-automation-eval-linear-world.json),
// as a run's sets and creates left it (bot-automation-eval-linear-writes.ts). Reads and searches
// answer as Orca Cloud's own;
// the connector service records those answers from its real verb code,
// and bot-automation-eval-linear.test.ts holds this file to them.
import WORLD from './bot-automation-eval-linear-world.json'
import {
  foldLinearName,
  linearNamed,
  onlyOneLinearNamed
} from '../../../cloud/packages/connector-contract/src/linear-issue-names'
import { lookUp, refuse } from './bot-automation-eval-linear-names'

type Team = (typeof WORLD.teams)[number]

export type LinearIssue = {
  id: string
  identifier: string
  title: string
  description?: string
  createdAt: string
  updatedAt: string
  state: string
  assignee?: string
  priority: number
  labels: string[]
  estimate?: number
  /** The parent issue's id, for a sub-issue. */
  parent?: string
}

/** A change a `set` made to an issue; null clears a field. */
export type LinearChange = Partial<Pick<LinearIssue, 'state' | 'priority' | 'labels'>> & {
  assignee?: string | null
  estimate?: number | null
}

/** What a run did to the world: the issues its sets changed, by key, and those it made. */
export type LinearRun = { changes?: Record<string, LinearChange>; created?: LinearIssue[] }

const DEFAULT_FOUND = 20
const MAX_FOUND = 50
const CLOSED_TYPES = ['completed', 'canceled', 'duplicate']
const PRIORITY_LABELS = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

export const issueRef = (issue: LinearIssue) => `linear:${WORLD.workspaceId}:${issue.id}`
export const teamRef = (team: Team) => `linear:${WORLD.workspaceId}:team:${team.id}`
export const teamOf = (issue: LinearIssue) =>
  WORLD.teams.find((team) => issue.identifier.startsWith(`${team.key}-`))!
const stateOf = (issue: LinearIssue) => WORLD.states.find((state) => state.name === issue.state)!
const memberOf = (id: string | undefined) => WORLD.members.find((member) => member.id === id)

export function applied(issue: LinearIssue, change: LinearChange = {}): LinearIssue {
  const { assignee, estimate, ...rest } = change
  return {
    ...issue,
    ...rest,
    ...(assignee === undefined ? {} : { assignee: assignee ?? undefined }),
    ...(estimate === undefined ? {} : { estimate: estimate ?? undefined })
  }
}

/** The world's issues as a run left them. */
export function linearIssues(run: LinearRun = {}): LinearIssue[] {
  return [...WORLD.issues, ...(run.created ?? [])].map((issue) =>
    applied(issue, run.changes?.[issue.identifier])
  )
}

/** An issue's fields as linear-issue-facts.ts gives them its owner; unset ones are left out. */
export function factsOf(issue: LinearIssue, issues: readonly LinearIssue[]) {
  const team = teamOf(issue)
  const assignee = memberOf(issue.assignee)
  const linked = (other: LinearIssue) => ({
    ref: issueRef(other),
    label: `${other.identifier} ${other.title}`
  })
  const parent = issues.find((other) => other.id === issue.parent)
  const children = issues.filter((other) => other.parent === issue.id)
  return {
    url: `https://linear.app/eval/issue/${issue.identifier}`,
    state: { name: issue.state, type: stateOf(issue).type },
    team: `${team.key} ${team.name}`,
    ...(issue.priority > 0 ? { priority: PRIORITY_LABELS[issue.priority] } : {}),
    ...(assignee ? { assignee: assignee.name } : {}),
    ...(issue.labels.length > 0 ? { labels: issue.labels } : {}),
    ...(issue.estimate === undefined ? {} : { estimate: issue.estimate }),
    ...(parent ? { parent: linked(parent) } : {}),
    ...(children.length > 0 ? { children: children.map(linked) } : {})
  }
}

/** The issue a key, link or ref names, if it is in the world. */
export function linearIssue(input: string, run?: LinearRun): LinearIssue | undefined {
  const wanted = input.trim()
  return linearIssues(run).find(
    (issue) =>
      wanted === issueRef(issue) ||
      new RegExp(`(^|/)${issue.identifier}($|[/?#])`, 'i').test(wanted)
  )
}

const WORKSPACE_REF = `linear:${WORLD.workspaceId}:workspace`

export function linearTeam(input: string): Team | undefined {
  const wanted = input.trim().toLowerCase()
  return WORLD.teams.find(
    (team) =>
      wanted === teamRef(team) ||
      wanted === team.key.toLowerCase() ||
      wanted === team.name.toLowerCase()
  )
}

const isWorkspace = (input: string) =>
  [WORKSPACE_REF, WORLD.workspaceName.toLowerCase()].includes(input.trim().toLowerCase())

/** What `find` lists for an issue's key, the workspace's name or a team's key or name, as the cloud labels each. */
export function linearMatches(input: string, run?: LinearRun): { ref: string; label: string }[] {
  const issue = linearIssue(input, run)
  const team = linearTeam(input)
  return [
    ...(issue ? [{ ref: issueRef(issue), label: `${issue.identifier} ${issue.title}` }] : []),
    ...(isWorkspace(input) ? [{ ref: WORKSPACE_REF, label: WORLD.workspaceName }] : []),
    ...(team ? [{ ref: teamRef(team), label: `${team.key} ${team.name}` }] : [])
  ]
}

/** A read of an issue: its fields, and its opening as the first message. */
export function readLinearIssue(issue: LinearIssue, run?: LinearRun) {
  const ref = issueRef(issue)
  const text = `${issue.title}\n\n${issue.description ?? ''}`.trim()
  return {
    target: { ref, label: `${issue.identifier} ${issue.title}` },
    facts: factsOf(issue, linearIssues(run)),
    messages: [
      {
        ref,
        label: `Linear: ${text.replace(/\s+/g, ' ')}`,
        author: 'Linear',
        text,
        at: Date.parse(issue.createdAt)
      }
    ]
  }
}

export type LinearSearch = { text?: string; state?: string; assignee?: string; label?: string }

/** A team's or the workspace's issues matching a search, latest activity first. Words match as
 *  substrings here; Linear ranks them by relevance, which no recording can stand in for. */
export function searchLinear(
  place: string,
  search: LinearSearch,
  limit = DEFAULT_FOUND,
  run?: LinearRun
) {
  const team = linearTeam(place)
  if (!team && !isWorkspace(place)) {
    return refuse('invalid_args', 'Search a Linear team or workspace: pass its key, name or ref.')
  }
  const open = foldLinearName(search.state ?? '') === 'open'
  const states = WORLD.states
  const state =
    !search.state || open
      ? null
      : team
        ? onlyOneLinearNamed('state', search.state, linearNamed('state', states, search.state))
        : onlyOneLinearNamed('state', search.state, lookUp('state', states, search.state))
  const person = search.assignee
    ? onlyOneLinearNamed(
        'person',
        search.assignee,
        lookUp('person', WORLD.members, search.assignee, (member) => [
          member.name,
          member.displayName
        ])
      )
    : null
  const label = search.label
    ? onlyOneLinearNamed(
        'label',
        search.label,
        lookUp(
          'label',
          WORLD.labels.map((name) => ({ name })),
          search.label
        )
      )
    : null
  // The first that names nothing, in the cloud's order.
  if (state && 'ok' in state) {
    return state
  }
  if (person && 'ok' in person) {
    return person
  }
  if (label && 'ok' in label) {
    return label
  }
  const words = search.text?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
  const found = linearIssues(run)
    .filter(
      (issue) =>
        (!team || teamOf(issue) === team) &&
        (!open || !CLOSED_TYPES.includes(stateOf(issue).type)) &&
        (!state || issue.state === state.name) &&
        (!person || issue.assignee === person.id) &&
        (!label || issue.labels.includes(label.name)) &&
        words.every((word) =>
          `${issue.title} ${issue.description ?? ''}`.toLowerCase().includes(word)
        )
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const shown = found.slice(0, Math.min(limit, MAX_FOUND))
  return {
    ok: true as const,
    result: {
      matches: shown.map((issue) => ({
        ref: issueRef(issue),
        label: [`${issue.identifier} ${issue.title}`, issue.state, memberOf(issue.assignee)?.name]
          .filter(Boolean)
          .join(' · ')
      })),
      ...(found.length > shown.length
        ? { note: 'More issues match than shown; narrow the search.' }
        : {})
    }
  }
}

/** `orca linear issue`'s answer: the owner's own view of the issue. */
export function ownerLinearIssue(input: string, run?: LinearRun) {
  const issue = linearIssue(input, run)
  if (!issue) {
    return undefined
  }
  const team = teamOf(issue)
  const assignee = memberOf(issue.assignee)
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: `https://linear.app/eval/issue/${issue.identifier}`,
    state: { ...stateOf(issue), color: '#888888' },
    team: { id: team.id, name: team.name, key: team.key },
    labels: issue.labels,
    labelIds: [],
    priority: issue.priority,
    ...(issue.estimate === undefined ? {} : { estimate: issue.estimate }),
    ...(assignee
      ? { assignee: { id: assignee.id, name: assignee.name, displayName: assignee.displayName } }
      : {})
  }
}
