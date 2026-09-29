import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every host-side call that builds an agent's startup command has made an attribution decision.
 *
 * `agent_started` is recorded per call site, and twice a new host builder shipped without one, so
 * that agent's launches were silently uncounted. A new call, or another call in a listed file,
 * fails here until its author decides and records whether that launch is a fresh start.
 */
const DECISIONS = ['attributes', 'resume', 'mobile-followup'] as const

const LISTED: ReadonlyMap<string, { calls: number; decision: string }> = new Map(
  readFileSync(join(__dirname, '__fixtures__', 'host-agent-startup-call-sites.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const [path, calls, decision] = line.split(/\s+/)
      return [path, { calls: Number(calls), decision }] as const
    })
)

const BUILDER_CALL =
  /\b(?:buildAgentStartupPlan|buildAgentDraftLaunchPlan|buildAgentResumeStartupPlan)\s*\(/g

const DECIDE =
  'Decide attribution: a fresh agent the host builds must carry ' +
  '`agentStartedTelemetry(agent, launchSource)` (src/main/agent-launch/agent-started-telemetry.ts) ' +
  'on its startup; a resume or a bare typed command must not. Then record the file, its call ' +
  'count and the decision in __fixtures__/host-agent-startup-call-sites.txt.'

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectSourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      return entry === '__fixtures__' ? [] : collectSourceFiles(full)
    }
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

/** Drop comment-only lines so prose naming a builder is not a call. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('host agent startup attribution', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..')
  const files = collectSourceFiles(join(repoRoot, 'src', 'main'))
  const found = new Map<string, number>()
  for (const file of files) {
    const path = relative(repoRoot, file).split('\\').join('/')
    const calls = isTestFile(path)
      ? 0
      : (codeText(readFileSync(file, 'utf8')).match(BUILDER_CALL)?.length ?? 0)
    if (calls > 0) {
      found.set(path, calls)
    }
  }

  it('scans a plausible number of files', () => {
    // A broken root would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('has an attribution decision for every builder call', () => {
    const undecided = [...found]
      .filter(([path, calls]) => calls > (LISTED.get(path)?.calls ?? 0))
      .map(([path, calls]) => `${path}: ${calls} calls, ${LISTED.get(path)?.calls ?? 0} decided`)
    expect(undecided, `New host-built agent startup. ${DECIDE}`).toEqual([])
  })

  it('has no stale entry', () => {
    // A count left above reality lets the next call in that file land without a decision.
    const stale = [...LISTED]
      .filter(([path, entry]) => entry.calls > (found.get(path) ?? 0))
      .map(([path, entry]) => `${path}: ${found.get(path) ?? 0} calls, ${entry.calls} listed`)
    expect(stale, 'Lower or delete the entry to match the calls that remain.').toEqual([])
  })

  it('uses the known decision vocabulary', () => {
    const unknown = [...LISTED].filter(
      ([, entry]) => !DECISIONS.some((decision) => decision === entry.decision)
    )
    expect(
      unknown.map(([path]) => path),
      `Use one of: ${DECISIONS.join(', ')}.`
    ).toEqual([])
  })
})
