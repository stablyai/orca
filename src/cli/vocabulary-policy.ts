import type { CommandSpec } from './args'

// Why: predictable verbs prevent failed agent guesses; existing divergences stay
// grandfathered because renaming them would break compatibility.

type VerbFamily = {
  name: string
  offPolicyVerbs: Set<string>
  canonical: string
  allowlist: Set<string>
}

const FAMILIES: VerbFamily[] = [
  {
    name: 'deletion',
    offPolicyVerbs: new Set(['remove', 'delete', 'destroy']),
    canonical: 'rm',
    allowlist: new Set([
      'cookie delete',
      'tab profile delete',
      'automations remove',
      'linear label remove'
    ])
  },
  {
    name: 'single-item read',
    offPolicyVerbs: new Set(['get']),
    canonical: 'show',
    allowlist: new Set(['get', 'cookie get', 'storage local get', 'storage session get'])
  }
]

export type VocabularyViolation = {
  command: string
  verb: string
  family: string
  canonical: string
}

function terminalVerb(path: string[]): string {
  return path.at(-1) ?? ''
}

function hasCanonicalAlias(spec: CommandSpec, canonical: string): boolean {
  const expected = [...spec.path.slice(0, -1), canonical]
  return (spec.aliases ?? []).some(
    (alias) =>
      alias.length === expected.length && alias.every((part, index) => part === expected[index])
  )
}

export function findVocabularyViolations(specs: CommandSpec[]): VocabularyViolation[] {
  const violations: VocabularyViolation[] = []
  for (const spec of specs) {
    const command = spec.path.join(' ')
    const verb = terminalVerb(spec.path)
    for (const family of FAMILIES) {
      if (!family.offPolicyVerbs.has(verb)) {
        continue
      }
      if (family.allowlist.has(command)) {
        continue
      }
      // Why: an alias on the canonical verb makes the command reachable the
      // canonical way, which satisfies the policy without a rename.
      if (hasCanonicalAlias(spec, family.canonical)) {
        continue
      }
      violations.push({ command, verb, family: family.name, canonical: family.canonical })
    }
  }
  return violations
}
