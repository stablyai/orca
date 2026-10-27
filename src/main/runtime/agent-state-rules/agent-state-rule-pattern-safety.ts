// Reject exponential regex backtracking at load: patterns run every poll without a linear-time engine.
// Adjacent overlapping quantifiers (\s*\s*x) are polynomial and remain undetected.
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

// Quantified groups with variable bodies can split failed input exponentially: (a+)*, (a?)+, (a|aa)+.
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
      // The ? in a group opener is not a quantifier.
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
