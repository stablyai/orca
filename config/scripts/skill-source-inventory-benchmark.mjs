import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { transform } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const path = 'src/renderer/src/components/skills/skill-source-inventory.ts'
const arms = {}
for (const [name, source] of [
  ['baseline', readFileSync(0, 'utf8')],
  ['indexed', readFileSync(path, 'utf8')]
]) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  assert.equal(typeof loaded.summarizeSkillSources, 'function', 'Pipe the baseline module on stdin')
  arms[name] = loaded.summarizeSkillSources
}

function verify(result) {
  const expected = arms.baseline(result)
  const actual = arms.indexed(result)
  assert.deepEqual(actual, expected)
  actual.forEach((entry, index) => assert.equal(entry.source, result.sources[index]))
  return expected
}

let seed = 20260911
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 0x100000000) * max)
}
const paths = [
  '/home/ada/.agents/skills',
  '/repo/.agents/skills',
  '/REPO/.agents/skills',
  '/remote/folder/.claude/skills',
  'C:\\Users\\Ada\\.codex\\skills',
  '\\\\wsl$\\Ubuntu\\home\\ada\\.agents\\skills',
  '',
  '/not-listed'
]
verify(null)
for (let trial = 0; trial < 5000; trial++) {
  const sources = Array.from({ length: random(25) }, (_, index) =>
    Object.freeze({
      id: `${index}`,
      path: paths[random(paths.length - 1)],
      exists: Boolean(random(2)),
      skippedReason: [undefined, 'missing', 'remote-repo', 'unavailable'][random(4)]
    })
  )
  const skills = []
  const count = random(100)
  for (let index = 0; index < count; index++) {
    skills.push(
      skills.length && random(4) === 0
        ? skills[random(skills.length)]
        : Object.freeze({
            rootPath: paths[random(paths.length)],
            rootPaths: random(3)
              ? Object.freeze(Array.from({ length: random(15) }, () => paths[random(paths.length)]))
              : undefined
          })
    )
  }
  verify(Object.freeze({ sources: Object.freeze(sources), skills: Object.freeze(skills) }))
}
console.log(
  JSON.stringify({
    differentialCases: 5001,
    node: process.version,
    platform: process.platform,
    arch: process.arch
  })
)

function workload(sourceCount, skillCount, rootsPerSkill) {
  const paths = Array.from(
    { length: sourceCount || 1 },
    (_, index) => `/repo-${index}/.agents/skills`
  )
  return {
    sources: paths.slice(0, sourceCount).map((path, index) => ({
      id: `${index}`,
      path,
      exists: index % 3 !== 0,
      skippedReason: index % 5 ? 'missing' : 'unavailable'
    })),
    skills: Array.from({ length: skillCount }, (_, index) => ({
      rootPath: paths[index % paths.length],
      rootPaths: Array.from(
        { length: rootsPerSkill },
        (_, rootIndex) => paths[(index + rootIndex) % paths.length]
      )
    }))
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[3] + sorted[4]) / 2
}

for (const [sourceCount, skillCount, rootsPerSkill] of [
  [0, 1000, 1],
  [1, 1000, 0],
  [1, 1000, 1],
  [17, 0, 0],
  [17, 20, 1],
  [17, 200, 1],
  [24, 1000, 3],
  [87, 1000, 3],
  [367, 5000, 3],
  [17, 200, 17]
]) {
  const input = workload(sourceCount, skillCount, rootsPerSkill)
  const expected = verify(input)
  const samples = { baseline: [], indexed: [] }
  const repeats = Math.max(
    5,
    Math.floor(200000 / (Math.max(1, sourceCount) * Math.max(1, skillCount)))
  )
  for (const run of Object.values(arms)) {
    for (let warmup = 0; warmup < Math.min(100, repeats); warmup++) {
      run(input)
    }
  }
  for (const pair of buildCounterbalancedSchedule(8, 'baseline', 'indexed')) {
    for (const arm of pair) {
      const start = performance.now()
      let result
      for (let repeat = 0; repeat < repeats; repeat++) {
        result = arms[arm](input)
      }
      samples[arm].push((performance.now() - start) / repeats)
      assert.deepEqual(result, expected)
    }
  }
  console.log(
    JSON.stringify({
      sourceCount,
      skillCount,
      rootsPerSkill,
      medianMs: Object.fromEntries(
        Object.entries(samples).map(([arm, values]) => [arm, median(values)])
      )
    })
  )
}
