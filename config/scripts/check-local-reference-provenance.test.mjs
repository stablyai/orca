import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectChangedFiles,
  findProvenanceMarkers,
  main,
  PROVENANCE_MARKERS
} from './check-local-reference-provenance.mjs'

// Why split: a spelled-out marker would make this file trip the gate it pins.
function marker(...parts) {
  return parts.join('')
}

const TRIPS = [
  {
    markerId: 'reference-corpus-citation',
    text: marker('// Behaviour confirmed across 5 refer', 'ence repos.')
  },
  {
    markerId: 'reference-survey-framing',
    text: marker('- The refer', 'ence survey settled the naming question.')
  },
  {
    // The real #14661 bullet heading this gate exists to keep out.
    markerId: 'precedent-framing',
    text: marker('- **Preced', 'ent check — aligned.** Process-owned restart recovery is standard.')
  },
  {
    // The real #14661 absence claim, verbatim apart from the split.
    markerId: 'absence-claim',
    text: marker(
      '  standard application precedent. N',
      'o directly comparable stale-`React.lazy`\n  asset-swap recovery w',
      'as found, so the epoch-gated remint remains Orca-specific.'
    )
  },
  {
    markerId: 'sole-comparable-claim',
    text: marker('// The on', 'e comparable implementation debounces on the trailing edge.')
  },
  {
    markerId: 'repo-survey-claim',
    text: marker('// Surve', 'yed the OSS repos before choosing this name.')
  }
]

// #909's actual comment text. Brennan ruled this acceptable: naming a public
// project Orca integrates with — and saying where in it something was read — is
// documentation, not a finding about the private corpus. It must keep passing.
const PR_909_COMMENT_TEXT = ` * we could run). We match Ghostty's taxonomy: US / US-International map to
 * \`true\`; everything else — including Dvorak, Colemak, UK, every
 * international layout — maps to \`false\`.
 *
 * Reference implementation in Ghostty:
 *   ~/projects/ghostty/src/input/keyboard.zig:25-57 (Layout enum + detectOptionAsAlt)
 *   ~/projects/ghostty/macos/Sources/Helpers/KeyboardLayout.swift (Carbon probe)
 *  \`'false'\` — the conservative safe choice, matching Ghostty's
 *  \`.unknown => .false\`.
 * explicit override. Matches Ghostty (Ghostty only whitelists
 * com.apple.keylayout.US and com.apple.keylayout.USInternational).
 * US Standard and US-International-PC — matching Ghostty's
 * \`detectOptionAsAlt\` (~/projects/ghostty/src/input/keyboard.zig:25-57
 * + ~/projects/ghostty/macos/Sources/Helpers/KeyboardLayout.swift,
 * which whitelists only \`com.apple.keylayout.US\` and
 * \`com.apple.keylayout.USInternational-PC\`).
    // Colemak is a US-variant but maps Semicolon → o. Matches Ghostty:
    // com.apple.keylayout.Colemak is not whitelisted there either.
    // Matches Ghostty: only US and USInternational-PC are allowlisted;`

// Further real lines from the tree that must keep passing.
const MUST_NOT_TRIP = [
  '// Reference implementation: the old eager rolling-string append the buffer',
  "await writeFile(join(realSkill, 'SKILL.md'), '# ref-oss\\n\\nUse local OSS reference repos.')",
  '  // must not count as snapshot-backed (changed from the ported prior art).',
  '// This split is without precedent in the renderer, so it ships behind a flag.',
  '// See the WHATWG spec for why the trailing slash is significant.',
  '// Chromium reports the layout map only for the base layer; we work around that.',
  "    coordinator.observeTitle('~/projects/app')"
]

const tempDirs = []

function git(root, args) {
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'gate',
      GIT_AUTHOR_EMAIL: 'gate@example.invalid',
      GIT_COMMITTER_NAME: 'gate',
      GIT_COMMITTER_EMAIL: 'gate@example.invalid'
    }
  })
}

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-reference-provenance-'))
  tempDirs.push(root)
  git(root, ['init'])
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  writeFileSync(path.join(root, 'note.ts'), '// Matches Ghostty behaviour.\n', 'utf8')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'base'])
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  return { root, baseSha }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('reference-corpus provenance markers', () => {
  it.each(TRIPS)('flags $markerId', ({ markerId, text }) => {
    expect(findProvenanceMarkers(text).map((finding) => finding.markerId)).toContain(markerId)
  })

  it('covers every declared marker with a tripping fixture', () => {
    expect(TRIPS.map((trip) => trip.markerId).sort()).toEqual(
      PROVENANCE_MARKERS.map((declared) => declared.id).sort()
    )
  })

  // The load-bearing negative: a pattern that flags this is over-broad by
  // definition, because naming a public project is not a corpus finding.
  it('leaves PR #909 comment text alone', () => {
    expect(findProvenanceMarkers(PR_909_COMMENT_TEXT)).toEqual([])
  })

  it.each(MUST_NOT_TRIP)('leaves legitimate line alone: %s', (line) => {
    expect(findProvenanceMarkers(line)).toEqual([])
  })

  // Why: the gate scans its own sources whenever they change, so an unassembled
  // marker in either file would make editing the gate impossible to land.
  it.each(['check-local-reference-provenance.mjs', 'check-local-reference-provenance.test.mjs'])(
    'keeps %s free of its own markers',
    (file) => {
      expect(
        findProvenanceMarkers(readFileSync(path.join(import.meta.dirname, file), 'utf8'))
      ).toEqual([])
    }
  )
})

describe('changed-file gate', () => {
  it('fails on a changed file carrying a corpus claim and passes once removed', () => {
    const { root, baseSha } = makeRepo()
    writeFileSync(
      path.join(root, 'note.ts'),
      `// Matches Ghostty behaviour.\n${TRIPS[0].text}\n`,
      'utf8'
    )
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'leak'])
    expect(main(root, baseSha)).toBe(1)

    writeFileSync(path.join(root, 'note.ts'), '// Matches Ghostty behaviour.\n', 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'clean'])
    expect(main(root, baseSha)).toBe(0)
  })

  it('passes a changed file carrying only public-project citations', () => {
    const { root, baseSha } = makeRepo()
    writeFileSync(path.join(root, 'note.ts'), `${PR_909_COMMENT_TEXT}\n`, 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'public citation'])
    expect(main(root, baseSha)).toBe(0)
  })

  it('scans new untracked files and skips unchanged ones', () => {
    const { root } = makeRepo()
    writeFileSync(path.join(root, 'untouched.md'), `${TRIPS[1].text}\n`, 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', 'pre-existing'])

    expect(collectChangedFiles(root, 'main').files).toEqual([])
    expect(main(root, 'main')).toBe(0)

    writeFileSync(path.join(root, 'new-note.md'), `${TRIPS[2].text}\n`, 'utf8')
    expect(collectChangedFiles(root, 'main').files).toContain('new-note.md')
    expect(main(root, 'main')).toBe(1)
  })
})
