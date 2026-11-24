import { describe, expect, it } from 'vitest'
import { lookAroundToolDecision } from './bot-look-around-policy'

describe('lookAroundToolDecision', () => {
  it.each(['gh pr view 12 --web=true', 'orca bot work forget', 'orca bot item add --title x'])(
    'refuses %s',
    (command) => {
      expect(lookAroundToolDecision('Bash', { command })).toBe('deny')
    }
  )
})
