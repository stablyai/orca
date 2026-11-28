import { parseTree, type Node } from 'jsonc-parser'

// Text splices keep every byte outside the statusLine key, so remove restores the original file.

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
export function insertStatusLineMember(text: string, entry: object): string | null {
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

/** Drops the statusLine member with the comma that joined it to a neighbor. */
export function removeStatusLineMember(text: string): string | null {
  const parsed = rootMembers(text)
  if (!parsed) {
    return null
  }
  const { root, members } = parsed
  const index = members.findIndex((member) => memberName(member) === 'statusLine')
  if (index === -1) {
    return text
  }
  const member = members[index]
  if (index > 0) {
    return text.slice(0, memberEnd(members[index - 1])) + text.slice(memberEnd(member))
  }
  if (members.length > 1) {
    return text.slice(0, member.offset) + text.slice(members[1].offset)
  }
  return text.slice(0, root.offset + 1) + text.slice(memberEnd(root) - 1)
}
