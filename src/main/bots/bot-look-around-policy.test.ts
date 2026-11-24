import { describe, expect, it } from 'vitest'
import { lookAroundToolDecision } from './bot-look-around-policy'

const bash = (command: string) => lookAroundToolDecision('Bash', { command })

describe('lookAroundToolDecision', () => {
  it.each([
    'gh pr view 12 --repo o/r',
    'orca bot list',
    'git log -3',
    "gh pr list --search 'is:open draft'"
  ])('allows %s', (command) => {
    expect(bash(command)).toEqual({ decision: 'allow' })
  })

  it.each([
    ['gh pr checks 12 | head', 'a pipe ("|")'],
    ['git status && git log -3', 'chaining ("&&")'],
    ['git log -3; git status', 'chaining (";")'],
    ['gh pr checks 12 2>&1', 'a redirect ("2>&1")'],
    ['gh pr list > out.txt', 'a redirect (">")'],
    ['gh pr view $(cat n)', 'expansion ("$(")'],
    ['gh pr list --search "is:open"', 'double quotes'],
    ["gh pr view 'x;y' | head", 'a pipe ("|")'],
    ['gh pr merge 12', '"gh pr merge" isn\'t a read'],
    ['orca bot item add --title x', '"orca bot item add" isn\'t a read'],
    ['rm -rf x', '"rm" isn\'t a read'],
    ['gh pr view 12 --web=true', '"gh pr view" may only read github.com'],
    ['git log --output=x', '"--output=x" makes "git log" more than a read'],
    ['git branch -D main', '"git branch" may only list branches']
  ])('refuses %s, naming %s', (command, named) => {
    const answer = bash(command)
    expect(answer.decision).toBe('deny')
    expect(answer.decision === 'deny' && answer.reason).toContain(named)
  })

  it('names a refused tool', () => {
    const answer = lookAroundToolDecision('PowerShell', { command: 'orca bot list' })
    expect(answer.decision === 'deny' && answer.reason).toContain('the PowerShell tool')
  })
})
