import { parseTree, visit, type Node, type ParseError } from 'jsonc-parser'

export type StatusLineEntry = { type: 'command'; command: string }

// Text splices keep every byte outside the statusLine key, so remove restores the original file.

export type StatusLineInspection =
  | { kind: 'empty' }
  /** `disabled`: agy has the line turned off; the command is still the slot's owner. */
  | { kind: 'command'; command: string; disabled: boolean }
  /** A statusLine object with settings of the user's but no command: an empty slot to fill. */
  | { kind: 'bare'; hasType: boolean }
  | { kind: 'unsupported'; detail: string }
  | { kind: 'invalid' }

const unsupported = (detail: string): StatusLineInspection => ({ kind: 'unsupported', detail })

/** Reads the statusLine slot from the same tree the splices edit; ambiguous shapes are refused. */
export function inspectStatusLine(text: string): StatusLineInspection {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || root?.type !== 'object') {
    return { kind: 'invalid' }
  }
  const found = (root.children ?? []).filter((member) => memberName(member) === 'statusLine')
  if (found.length === 0) {
    return { kind: 'empty' }
  }
  const value = found[0].children?.[1]
  if (found.length > 1 || value?.type !== 'object') {
    return unsupported("agy's statusLine setting is not a single command object")
  }
  const named = (name: string): Node[] =>
    (value.children ?? []).filter((member) => memberName(member) === name)
  const typeNodes = named('type')
  if (
    named('command').length === 0 &&
    typeNodes.length <= 1 &&
    (typeNodes.length === 0 || typeNodes[0].children?.[1]?.value === 'command')
  ) {
    return named('enabled').some((member) => member.children?.[1]?.value === false)
      ? unsupported("agy's status line is turned off")
      : { kind: 'bare', hasType: typeNodes.length === 1 }
  }
  const commandNode = named('command')[0]?.children?.[1]
  const typeValue = named('type')[0]?.children?.[1]?.value
  if (
    named('type').length > 1 ||
    named('command').length !== 1 ||
    commandNode?.type !== 'string' ||
    (named('type').length === 1 && typeValue !== 'command')
  ) {
    return unsupported("agy's statusLine setting is not a single command object")
  }
  const disabled = named('enabled').some((member) => member.children?.[1]?.value === false)
  return { kind: 'command', command: String(commandNode.value), disabled }
}

/** True when the file holds a line or block comment outside any string. */
export function hasJsonComments(text: string): boolean {
  let found = false
  visit(text, { onComment: () => (found = true) }, { allowTrailingComma: true })
  return found
}

function rootMembers(text: string): { root: Node; members: Node[] } | null {
  const root = parseTree(text, [], { allowTrailingComma: true })
  return root?.type === 'object' ? { root, members: root.children ?? [] } : null
}

function memberName(member: Node): unknown {
  return member.children?.[0]?.value
}

function memberEnd(member: Node): number {
  return member.offset + member.length
}

/** Swaps the statusLine command's JSON literal and returns the literal it replaced. */
export function replaceStatusLineCommand(
  text: string,
  commandLiteral: string
): { text: string; previousLiteral: string } | null {
  const statusLine = rootMembers(text)?.members.find(
    (member) => memberName(member) === 'statusLine'
  )
  const command = statusLine?.children?.[1]?.children?.find(
    (member) => memberName(member) === 'command'
  )?.children?.[1]
  if (!command) {
    return null
  }
  const end = command.offset + command.length
  return {
    text: text.slice(0, command.offset) + commandLiteral + text.slice(end),
    previousLiteral: text.slice(command.offset, end)
  }
}

/** Appends a statusLine member in the file's own indentation, or null when the root is not an object. */
export function insertStatusLineMember(text: string, entry: StatusLineEntry): string | null {
  const parsed = rootMembers(text)
  if (!parsed) {
    return null
  }
  const { root, members } = parsed
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const last = members.at(-1)
  if (!last) {
    const unit = '  '
    const member = `"statusLine": ${JSON.stringify(entry, null, unit).replaceAll('\n', eol + unit)}`
    return `${text.slice(0, root.offset + 1)}${eol}${unit}${member}${eol}${text.slice(memberEnd(root) - 1)}`
  }
  const lead = /\s*$/.exec(text.slice(0, last.offset))?.[0] ?? ''
  const indent = lead.slice(lead.lastIndexOf('\n') + 1)
  const [key, value] = last.children ?? []
  const colon = key && value ? text.slice(memberEnd(key), value.offset) : ': '
  const rendered = lead.includes('\n')
    ? JSON.stringify(entry, null, indent || '  ').replaceAll('\n', eol + indent)
    : JSON.stringify(entry)
  return `${text.slice(0, memberEnd(last))},${lead}"statusLine"${colon}${rendered}${text.slice(memberEnd(last))}`
}

/** Removes `members[index]` of `container` with the comma that joined it to a neighbor. */
function spliceMember(text: string, container: Node, members: Node[], index: number): string {
  const member = members[index]
  if (index > 0) {
    return text.slice(0, memberEnd(members[index - 1])) + text.slice(memberEnd(member))
  }
  if (members.length > 1) {
    return text.slice(0, member.offset) + text.slice(members[1].offset)
  }
  return text.slice(0, container.offset + 1) + text.slice(memberEnd(container) - 1)
}

/** Drops the statusLine member with the comma that joined it to a neighbor. */
export function removeStatusLineMember(text: string): string | null {
  const parsed = rootMembers(text)
  if (!parsed) {
    return null
  }
  const index = parsed.members.findIndex((member) => memberName(member) === 'statusLine')
  return index === -1 ? text : spliceMember(text, parsed.root, parsed.members, index)
}

/** Adds `type` (if asked) and `command` to the end of the existing statusLine object. */
export function addStatusLineKeys(
  text: string,
  addType: boolean,
  commandLiteral: string
): string | null {
  const statusLine = rootMembers(text)?.members.find(
    (member) => memberName(member) === 'statusLine'
  )?.children?.[1]
  if (statusLine?.type !== 'object') {
    return null
  }
  const members = statusLine.children ?? []
  const last = members.at(-1)
  const [key, value] = last?.children ?? []
  const lead = last ? (/\s*$/.exec(text.slice(0, last.offset))?.[0] ?? '') : ''
  const colon = key && value ? text.slice(memberEnd(key), value.offset) : ': '
  const typePart = addType ? `"type"${colon}"command",${lead || ' '}` : ''
  const added = `${typePart}"command"${colon}${commandLiteral}`
  if (!last) {
    return `${text.slice(0, statusLine.offset + 1)}${added}${text.slice(memberEnd(statusLine) - 1)}`
  }
  return `${text.slice(0, memberEnd(last))},${lead}${added}${text.slice(memberEnd(last))}`
}

/**
 * Takes back what an install put into a statusLine that did not exist before: its `type` and
 * `command`. Keys the user added since stay, and the statusLine goes only once it is empty.
 */
export function removeInsertedStatusLineKeys(
  text: string,
  keys: readonly string[] = ['command', 'type']
): string | null {
  let next = text
  for (const key of keys) {
    const statusLine = rootMembers(next)?.members.find(
      (member) => memberName(member) === 'statusLine'
    )?.children?.[1]
    const members = statusLine?.children ?? []
    const index = members.findIndex((member) => memberName(member) === key)
    if (!statusLine || statusLine.type !== 'object') {
      return null
    }
    if (index !== -1) {
      next = spliceMember(next, statusLine, members, index)
    }
  }
  const left = rootMembers(next)?.members.find((member) => memberName(member) === 'statusLine')
  return (left?.children?.[1]?.children ?? []).length === 0 ? removeStatusLineMember(next) : next
}
