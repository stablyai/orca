import { describe, expect, it } from 'vitest'
import {
  classifyCodexRateLimitWindows,
  type CodexRateLimitWindowsSnapshot
} from './codex-rate-limit-window-classification'

function usedPercentByWindow(result: CodexRateLimitWindowsSnapshot | null): {
  session: number | null
  weekly: number | null
} {
  const classified = classifyCodexRateLimitWindows(result)
  return {
    session: classified.session?.usedPercent ?? null,
    weekly: classified.weekly?.usedPercent ?? null
  }
}

describe('classifyCodexRateLimitWindows', () => {
  it.each([
    {
      name: 'reordered known windows',
      result: {
        primary: { usedPercent: 81, windowDurationMins: 10080 },
        secondary: { usedPercent: 21, windowDurationMins: 300 }
      },
      expected: { session: 21, weekly: 81 }
    },
    {
      name: 'duplicate session windows',
      result: {
        primary: { usedPercent: 41, windowDurationMins: 300 },
        secondary: { usedPercent: 42, windowDurationMins: 300 }
      },
      expected: { session: 41, weekly: null }
    },
    {
      name: 'duplicate weekly windows',
      result: {
        primary: { usedPercent: 51, windowDurationMins: 10080 },
        secondary: { usedPercent: 52, windowDurationMins: 10080 }
      },
      expected: { session: null, weekly: 51 }
    },
    {
      name: 'malformed usage',
      result: {
        primary: { usedPercent: Number.NaN, windowDurationMins: 300 },
        secondary: { usedPercent: 61, windowDurationMins: 10080 }
      },
      expected: { session: null, weekly: 61 }
    },
    {
      name: 'reordered near-canonical windows',
      result: {
        primary: { usedPercent: 81, windowDurationMins: 10081 },
        secondary: { usedPercent: 82, windowDurationMins: 299 }
      },
      expected: { session: 82, weekly: 81 }
    },
    {
      name: 'opposite near-canonical boundaries',
      result: {
        primary: { usedPercent: 83, windowDurationMins: 10079 },
        secondary: { usedPercent: 84, windowDurationMins: 301 }
      },
      expected: { session: 84, weekly: 83 }
    },
    {
      name: 'known session wins over unknown primary fallback',
      result: {
        primary: { usedPercent: 111, windowDurationMins: 60 },
        secondary: { usedPercent: 112, windowDurationMins: 300 }
      },
      expected: { session: 112, weekly: null }
    },
    {
      name: 'known weekly wins over unknown secondary fallback',
      result: {
        primary: { usedPercent: 121, windowDurationMins: 10080 },
        secondary: { usedPercent: 122, windowDurationMins: 60 }
      },
      expected: { session: null, weekly: 121 }
    }
  ] as const)('$name', ({ result, expected }) => {
    expect(usedPercentByWindow(result)).toEqual(expected)
  })
})
