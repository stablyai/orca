// Aggregates a V8 heap snapshot by constructor and diffs two of them.
//
// Reports object COUNT and total SELF size per constructor, not true retained size -- retained size
// needs a dominator tree, and for finding what churn retains, a constructor whose instance count
// climbs with the cycle count is the signal. Counts are exact.
//
// Usage: node relay-heap-snapshot-diff.mjs <before.heapsnapshot> <after.heapsnapshot> [topN]
import { readFileSync } from 'node:fs'

function aggregate(path) {
  const snap = JSON.parse(readFileSync(path, 'utf8'))
  const fields = snap.snapshot.meta.node_fields
  const typeNames = snap.snapshot.meta.node_types[0]
  const width = fields.length
  const iType = fields.indexOf('type')
  const iName = fields.indexOf('name')
  const iSelf = fields.indexOf('self_size')
  const nodes = snap.nodes
  const strings = snap.strings
  const byCtor = new Map()
  let totalSelf = 0
  for (let off = 0; off < nodes.length; off += width) {
    const type = typeNames[nodes[off + iType]]
    const name = strings[nodes[off + iName]]
    const self = nodes[off + iSelf]
    totalSelf += self
    // Key on type+name: "object/Foo" and "string" land in distinct buckets.
    const key = `${type}/${name}`
    const cur = byCtor.get(key)
    if (cur) {
      cur.count++
      cur.self += self
    } else {
      byCtor.set(key, { count: 1, self })
    }
  }
  return { byCtor, totalSelf, nodeCount: nodes.length / width }
}

const [beforePath, afterPath, topRaw] = process.argv.slice(2)
if (!beforePath || !afterPath) {
  console.error('usage: relay-heap-snapshot-diff.mjs <before> <after> [topN]')
  process.exit(1)
}
const top = Number.parseInt(topRaw ?? '25', 10)

const a = aggregate(beforePath)
const b = aggregate(afterPath)

const keys = new Set([...a.byCtor.keys(), ...b.byCtor.keys()])
const rows = []
for (const key of keys) {
  const x = a.byCtor.get(key) ?? { count: 0, self: 0 }
  const y = b.byCtor.get(key) ?? { count: 0, self: 0 }
  const dCount = y.count - x.count
  const dSelf = y.self - x.self
  if (dCount === 0 && dSelf === 0) {
    continue
  }
  rows.push({
    key,
    beforeCount: x.count,
    afterCount: y.count,
    dCount,
    dSelfKb: +(dSelf / 1024).toFixed(1)
  })
}

console.log(
  JSON.stringify(
    {
      before: { nodeCount: a.nodeCount, totalSelfMb: +(a.totalSelf / 1048576).toFixed(3) },
      after: { nodeCount: b.nodeCount, totalSelfMb: +(b.totalSelf / 1048576).toFixed(3) },
      deltaSelfMb: +((b.totalSelf - a.totalSelf) / 1048576).toFixed(3),
      deltaNodeCount: b.nodeCount - a.nodeCount
    },
    null,
    1
  )
)
console.log('\n--- top growth by self size ---')
for (const r of rows.sort((p, q) => q.dSelfKb - p.dSelfKb).slice(0, top)) {
  console.log(JSON.stringify(r))
}
console.log('\n--- top growth by instance count ---')
for (const r of rows.sort((p, q) => q.dCount - p.dCount).slice(0, top)) {
  console.log(JSON.stringify(r))
}
