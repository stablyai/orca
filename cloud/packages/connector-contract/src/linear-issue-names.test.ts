import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CONNECTOR_PRIORITIES } from './action-messages.js'
import {
  LINEAR_PRIORITY_NUMBERS,
  linearIssueIdFor,
  linearLabelsClash,
  linearNamed,
  onlyOneLinearNamed
} from './linear-issue-names.js'

describe('linearIssueIdFor', () => {
  it('gives each post key one version 4 UUID, the same every time', () => {
    const id = linearIssueIdFor('account:bot:post-1')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(linearIssueIdFor('account:bot:post-1')).toBe(id)
    expect(linearIssueIdFor('account:bot:post-2')).not.toBe(id)
  })
})

// The connector's matching as it stood before it moved here (the service's linear-names.ts,
// linear-issue-fields.ts, linear-issue-create.ts), frozen as the oracle the move must not change.
const before = (() => {
  const refuse = (refusal: string, message: string) => ({ ok: false as const, refusal, message })
  const fold = (name: string) => name.trim().toLowerCase()
  const distinctNames = (named: readonly { name: string }[]) =>
    named.filter((entry, at) => named.findIndex((other) => fold(other.name) === fold(entry.name)) === at).map((entry) => entry.name)
  function byName<T extends { name: string }>(
    kind: string,
    candidates: readonly T[],
    wanted: string,
    namesOf: (candidate: T) => readonly string[] = (candidate) => [candidate.name]
  ) {
    const want = fold(wanted)
    const named = (match: (name: string) => boolean) =>
      candidates.filter((candidate) => namesOf(candidate).some((name) => match(fold(name))))
    const whole = named((name) => name === want)
    const matched = whole.length > 0 ? whole : named((name) => name.startsWith(want))
    const names = distinctNames(matched)
    if (names.length === 1) {
      return matched
    }
    const listed = (names.length > 0 ? names : distinctNames(candidates)).slice(0, 10)
    return names.length > 1
      ? refuse('ambiguous', `"${wanted}" could be more than one ${kind}: ${listed.join(', ')}. Pass the whole name.`)
      : refuse('not_found', `No ${kind} is named "${wanted}"${listed.length > 0 ? `; there are: ${listed.join(', ')}` : ''}.`)
  }
  function onlyOne<T>(kind: string, wanted: string, found: T[] | ReturnType<typeof refuse>) {
    if (!Array.isArray(found)) {
      return found
    }
    const [only, ...others] = found
    return only && others.length === 0
      ? only
      : refuse('ambiguous', `More than one ${kind} is named "${wanted}"; Linear can't tell them apart by name.`)
  }
  function clash(addLabels?: string[], removeLabels?: string[]) {
    const both = addLabels?.find((name) => removeLabels?.some((other) => other.trim().toLowerCase() === name.trim().toLowerCase()))
    return both ? refuse('invalid_args', `"${both}" is both added and removed; name it once.`) : null
  }
  function issueIdFor(key: string): string {
    const hex = createHash('sha256').update(`orca-linear-create:${key}`).digest('hex')
    const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  const priority = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 }
  return { byName, onlyOne, clash, issueIdFor, priority }
})()

type Person = { id: string; name: string; displayName: string }
const states = [
  { id: 's1', name: 'Todo' },
  { id: 's2', name: 'In Progress' },
  { id: 's3', name: 'In Review' },
  { id: 's4', name: 'Done' },
  { id: 's5', name: 'todo' },
  { id: 's6', name: '  Done ' }
]
const many = Array.from({ length: 14 }, (_, at) => ({ id: `l${at}`, name: `Area ${at}` }))
const people: Person[] = [
  { id: 'u1', name: 'Ada Lovelace', displayName: 'ada' },
  { id: 'u2', name: 'Alan Turing', displayName: 'alan' },
  { id: 'u3', name: 'Ada King', displayName: 'ada.k' }
]
const peopleNames = (person: Person) => [person.name, person.displayName]
const wanted = ['todo', 'TODO', ' Todo ', 'in', 'In Pro', 'in review', 'done', 'Do', 'x', '', '  ', 'In Progress!']

describe('linear names match as the connector matched them before the move', () => {
  it.each(wanted)('state %j', (name) => {
    expect(linearNamed('state', states, name)).toEqual(before.byName('state', states, name))
    expect(onlyOneLinearNamed('state', name, linearNamed('state', states, name))).toEqual(
      before.onlyOne('state', name, before.byName('state', states, name))
    )
  })

  it.each(['ada', 'Ada', 'al', 'alan turing', 'ADA.K', 'grace', 'a'])('person %j by name or display name', (name) => {
    expect(linearNamed('person', people, name, peopleNames)).toEqual(before.byName('person', people, name, peopleNames))
    expect(onlyOneLinearNamed('person', name, linearNamed('person', people, name, peopleNames))).toEqual(
      before.onlyOne('person', name, before.byName('person', people, name, peopleNames))
    )
  })

  it.each(['area', 'Area 1', 'none', 'Area 13'])('label %j among more than a refusal lists', (name) => {
    expect(linearNamed('label', many, name)).toEqual(before.byName('label', many, name))
  })

  it('refuses nothing to pick from the same way', () => {
    expect(linearNamed('label', [], 'bug')).toEqual(before.byName('label', [], 'bug'))
    expect(onlyOneLinearNamed('label', 'bug', [])).toEqual(before.onlyOne('label', 'bug', []))
  })

  it.each([
    [undefined, undefined],
    [['Bug'], undefined],
    [undefined, ['Bug']],
    [['Bug', 'UI'], ['ui ']],
    [[' bug'], ['BUG']],
    [['Bug'], ['Feature']]
  ])('label clash add %j remove %j', (add, remove) => {
    expect(linearLabelsClash(add, remove)).toEqual(before.clash(add, remove))
  })

  it('keeps priority numbers and create ids', () => {
    expect(LINEAR_PRIORITY_NUMBERS).toEqual(before.priority)
    expect(Object.keys(LINEAR_PRIORITY_NUMBERS).sort()).toEqual([...CONNECTOR_PRIORITIES].sort())
    for (const key of ['', 'a', 'account:bot:post-1', 'ü'.repeat(40)]) {
      expect(linearIssueIdFor(key)).toBe(before.issueIdFor(key))
    }
  })
})
