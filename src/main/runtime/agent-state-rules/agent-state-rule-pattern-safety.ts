// Why a subset: rule patterns run on every poll, and Node has no linear-time regex engine, so a
// pattern that can backtrack exponentially is refused when the file loads. Overlapping adjacent
// quantifiers (`\s*\s*x`) are polynomial and not detected.
export function findUnsafePatternReason(pattern: string): string | null {
  try {
    new RegExp(pattern)
  } catch {
    return 'does not compile'
  }
  if (/\\[1-9]|\\k</.test(pattern)) {
    return 'uses a backreference'
  }
  if (/\(\?<[=!]/.test(pattern)) {
    return 'uses a lookbehind'
  }
  return repeatsAVariableGroup(pattern)
    ? 'repeats a group that can match in more than one way'
    : null
}

function isRepeatingQuantifier(char: string | undefined): boolean {
  return char === '*' || char === '+' || char === '{'
}

// A repeated group whose body varies, by a quantifier or an alternation: `(a+)*`, `(a?)+`,
// `(a|aa)+`. Such a body can split one input many ways, each of which a failed match retries.
function repeatsAVariableGroup(pattern: string): boolean {
  const groupVaries: boolean[] = []
  let inClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\') {
      index += 1
    } else if (inClass) {
      inClass = char !== ']'
    } else if (char === '[') {
      inClass = true
    } else if (char === '(') {
      groupVaries.push(false)
      // Why skip: the `?` of `(?:`, `(?=` or `(?<name>` opens a group; it quantifies nothing.
      if (pattern[index + 1] === '?') {
        index += 1
      }
    } else if (char === ')') {
      const bodyVaries = groupVaries.pop() ?? false
      if (bodyVaries && isRepeatingQuantifier(pattern[index + 1])) {
        return true
      }
      if (bodyVaries && groupVaries.length > 0) {
        groupVaries[groupVaries.length - 1] = true
      }
    } else if (
      (isRepeatingQuantifier(char) || char === '?' || char === '|') &&
      groupVaries.length > 0
    ) {
      groupVaries[groupVaries.length - 1] = true
    }
  }
  return false
}
