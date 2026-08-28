import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why (#11960): behavioural tests only reach one of the removal branches in each
// file, so re-deriving the waiver from `force` at any of the others stays green
// while silently disabling the PTY gate on that path. `force` is set by the
// ordinary delete confirmation (to skip the dirty-file prompt) and is NOT user
// intent to delete past live terminals — so pin the wiring itself, at every site.
const FILE_GROUPS = [
  {
    label: 'extracted worktree removal',
    files: [
      join(__dirname, '..', 'ipc', 'worktrees', 'removal', 'worktree-removal-ownership.ts'),
      join(__dirname, '..', 'ipc', 'worktrees', 'removal', 'remove-registered-local-worktree.ts'),
      join(__dirname, '..', 'ipc', 'worktrees', 'removal', 'remove-registered-remote-worktree.ts'),
      join(__dirname, '..', 'ipc', 'worktrees', 'removal', 'remove-unregistered-worktree.ts')
    ]
  },
  {
    label: 'runtime removal',
    files: [join(__dirname, 'orca-runtime.ts')]
  }
] as const

// Why: a comment quoting `allowUnverifiedStop:` would otherwise count as a site —
// and this very invariant invites people to write one in the file it guards.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

describe('the PTY-stop waiver is never derived from `force`', () => {
  it.each(FILE_GROUPS)('$label paths pass only an explicit waiver to the teardown', ({ files }) => {
    const source = stripComments(files.map((file) => readFileSync(file, 'utf8')).join('\n'))

    // Why: derived, not hardcoded — merging two removal branches is a legitimate
    // refactor and must not read as a deleted safety wiring, while dropping the
    // waiver from a branch that still exists must still fail loudly.
    const teardownCallSites =
      [...source.matchAll(/stopPtysForDestructiveWorktreeRemoval\(/g)].length - 1
    expect(teardownCallSites).toBeGreaterThan(0)

    const values = [...source.matchAll(/allowUnverifiedStop:\s*([^,\n}]+)/g)].map((match) =>
      match[1].trim()
    )
    // One per call site, plus the single conditional spread inside the helper.
    expect(values).toHaveLength(teardownCallSites + 1)
    for (const value of values) {
      expect(value).not.toMatch(/\bforce\b/)
      // Positive check too: "not literally force" would still admit any other
      // in-scope boolean being wired in by mistake.
      expect(value).toMatch(/^(?:args\.)?allowUnverifiedPtyStop$|^true$/)
    }
    // Only the helper's spread may hardcode `true`; a call site doing so would
    // waive unconditionally.
    expect(values.filter((value) => value === 'true')).toHaveLength(1)

    // Why: checking the value alone is not enough — `...(force || allowUnverifiedStop
    // ? { allowUnverifiedStop: true } : {})` re-disables the gate on every confirmed
    // delete while the value stays a blameless `true`. Pin the guarding condition too.
    // Lazy `[\s\S]*?` rather than `[^?]*` so an optional chain (`args?.force`) inside
    // the condition cannot end the match early and slip the whole check.
    const conditions = [
      ...source.matchAll(/\.\.\.\(([\s\S]{0,200}?)\?\s*\{\s*allowUnverifiedStop:/g)
    ].map((match) => match[1].trim())
    expect(conditions).toHaveLength(1)
    for (const condition of conditions) {
      expect(condition).not.toMatch(/\bforce\b/i)
    }
  })
})
