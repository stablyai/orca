import {
  checkpointListDifference,
  excerpt,
  groupDifferences,
  identityDifferences,
  recordingDifferences,
  type DecodedGolden,
  type GroupedDifference
} from '../src/test-support/rpc-recording/golden-difference'

export type GoldenChange = {
  id: string
  family: string
  identity: ReturnType<typeof identityDifferences>
  checkpoints: ReturnType<typeof checkpointListDifference>
  differences: GroupedDifference[]
}
export type GoldenChangeSet = {
  base: string
  total: number
  changed: GoldenChange[]
  added: { id: string; family: string }[]
  removed: { id: string; family: string }[]
}

export function diffGoldenSets(
  base: string,
  before: ReadonlyMap<string, DecodedGolden>,
  after: ReadonlyMap<string, DecodedGolden>
): GoldenChangeSet {
  const changed: GoldenChange[] = []
  for (const [id, golden] of after) {
    const previous = before.get(id)
    if (!previous) {
      continue
    }
    const identity = identityDifferences(previous, golden)
    const checkpoints = checkpointListDifference(previous.recording, golden.recording)
    const differences = groupDifferences(recordingDifferences(previous.recording, golden.recording))
    if (
      identity.length ||
      checkpoints.missing.length ||
      checkpoints.extra.length ||
      checkpoints.reordered ||
      differences.length
    ) {
      changed.push({ id, family: golden.family, identity, checkpoints, differences })
    }
  }
  const only = (
    from: ReadonlyMap<string, DecodedGolden>,
    other: ReadonlyMap<string, DecodedGolden>
  ) =>
    [...from]
      .filter(([id]) => !other.has(id))
      .map(([id, golden]) => ({ id, family: golden.family }))
  const byFamily = <T extends { id: string; family: string }>(items: T[]): T[] =>
    items.sort(
      (left, right) => left.family.localeCompare(right.family) || left.id.localeCompare(right.id)
    )
  return {
    base,
    total: after.size,
    changed: byFamily(changed),
    added: byFamily(only(after, before)),
    removed: byFamily(only(before, after))
  }
}

export function changeSetIsEmpty(set: GoldenChangeSet): boolean {
  return !set.changed.length && !set.added.length && !set.removed.length
}

function headline(set: GoldenChangeSet): string {
  return `${set.changed.length} changed, ${set.added.length} added, ${set.removed.length} removed (${set.total} goldens now)`
}

/** One golden's changes as lines, the first `limit` grouped differences in full. */
export function describeGoldenChange(change: GoldenChange, limit: number, width = 600): string[] {
  const lines: string[] = []
  for (const moved of change.identity) {
    lines.push(
      `${moved.field}: ${JSON.stringify(moved.expected)} -> ${JSON.stringify(moved.actual)}`
    )
  }
  if (change.checkpoints.missing.length) {
    lines.push(`checkpoints no longer recorded: ${change.checkpoints.missing.join(', ')}`)
  }
  if (change.checkpoints.extra.length) {
    lines.push(`checkpoints newly recorded: ${change.checkpoints.extra.join(', ')}`)
  }
  if (change.checkpoints.reordered) {
    lines.push('checkpoints recorded in a different order')
  }
  for (const difference of change.differences.slice(0, limit)) {
    const [first, ...rest] = difference.checkpoints
    const also = rest.length
      ? ` (and ${rest.length} later checkpoint${rest.length === 1 ? '' : 's'})`
      : ''
    lines.push(`checkpoint ${first} field ${difference.field}${difference.path}${also}`)
    lines.push(`  was ${excerpt(difference.expected, width)}`)
    lines.push(`  now ${excerpt(difference.actual, width)}`)
  }
  if (change.differences.length > limit) {
    lines.push(`… ${change.differences.length - limit} more differences`)
  }
  return lines
}

export function formatChangeText(set: GoldenChangeSet, limit = 5): string {
  if (changeSetIsEmpty(set)) {
    return `No recorded behaviour moved against ${set.base}.\n`
  }
  const lines = [`RPC recordings against ${set.base}: ${headline(set)}`]
  for (const change of set.changed) {
    lines.push('', `changed ${change.id} [${change.family}]`)
    lines.push(...describeGoldenChange(change, limit).map((line) => `  ${line}`))
  }
  for (const [label, items] of [
    ['added', set.added],
    ['removed', set.removed]
  ] as const) {
    if (items.length) {
      lines.push('', `${label}:`, ...items.map((item) => `  ${item.id} [${item.family}]`))
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * GitHub caps one step summary at 1 MiB, and a recorder change can move ~700 goldens. Families are
 * listed in full; details stop at `maxBytes`, so the tail of a large change is names only.
 */
export function formatChangeMarkdown(set: GoldenChangeSet, maxBytes = 200_000): string {
  if (changeSetIsEmpty(set)) {
    return ''
  }
  const out: string[] = [
    '## RPC recording changes',
    '',
    `Against \`${set.base.slice(0, 12)}\`: ${headline(set)}. Reproduce with \`pnpm --dir mobile rpc:diff ${set.base.slice(0, 12)}\`.`,
    ''
  ]
  let size = out.join('\n').length
  let detailed = true
  const families = new Map<string, GoldenChange[]>()
  for (const change of set.changed) {
    families.set(change.family, [...(families.get(change.family) ?? []), change])
  }
  for (const [family, changes] of families) {
    out.push(`<details><summary><code>${family}</code>: ${changes.length} changed</summary>`, '')
    for (const change of changes) {
      const body = detailed ? describeGoldenChange(change, 3, 300) : []
      const block = [`**${change.id}**`, ...(body.length ? ['```', ...body, '```'] : []), '']
      const blockSize = block.join('\n').length
      if (detailed && size + blockSize > maxBytes) {
        detailed = false
        out.push('_Details stop here to fit the summary; the rest are listed by name._', '')
      }
      const shown = detailed ? block : [`- ${change.id}`]
      out.push(...shown)
      size += shown.join('\n').length
    }
    out.push('</details>', '')
  }
  for (const [label, items] of [
    ['Added goldens', set.added],
    ['Removed goldens', set.removed]
  ] as const) {
    if (items.length) {
      out.push(
        `### ${label} (${items.length})`,
        '',
        ...items.map((item) => `- ${item.id} (\`${item.family}\`)`),
        ''
      )
    }
  }
  return `${out.join('\n')}\n`
}
