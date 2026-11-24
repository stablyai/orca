import { describe, expect, it } from 'vitest'
import { lookAroundToolDecision } from './bot-look-around-policy'

const ALLOW = 'allow'

/** [command, ALLOW or text the refusal names]: Bash first, then PowerShell. */
const BASH: readonly (readonly [string, string])[] = [
  ['gh pr view 12 --repo o/r', ALLOW],
  ['orca bot list', ALLOW],
  ['orca bot item show 3', ALLOW],
  ['git log -3', ALLOW],
  ["gh pr list --search 'is:open draft'", ALLOW],
  ['gh pr list --author @me --json number,title', ALLOW],
  ['gh pr checks 12 2>&1', ALLOW],
  ['gh pr checks 12 2>/dev/null', ALLOW],
  ['git status && git log -3', ALLOW],
  ['git log -3; git status', ALLOW],
  ['git log -3 ; git status ; git diff', ALLOW],
  ['git status&&git log -1', ALLOW],
  ['gh pr view 12 || gh pr list', ALLOW],
  ['gh pr checks 12 2>&1 && gh run list --limit 5 2>/dev/null', ALLOW],
  ["gh pr list --search 'a;b && c || d'", ALLOW],
  ['"${ORCA_CLI_COMMAND:-orca}" bot list && "${ORCA_CLI_COMMAND:-orca}" bot chats', ALLOW],
  ["/bin/zsh -lc 'git status && git log -3 2>&1'", ALLOW],
  // Pipes, other redirects, expansion and subshells.
  ['gh pr checks 12 | head', 'a pipe ("|")'],
  ['gh pr list |tee out', 'a pipe ("|")'],
  ['gh pr checks 12 2>&1 | head', 'a pipe ("|")'],
  ['git log -3 |& cat', 'a pipe ("|")'],
  ['git log ||| rm x', 'a pipe ("|")'],
  ["gh pr view 'x;y' | head", 'a pipe ("|")'],
  ['gh pr list > out.txt', 'a redirect (">")'],
  ['gh pr list >> log', 'a redirect (">>")'],
  ['gh pr checks 12 2>file', 'a redirect ("2>")'],
  ['gh pr checks 12 2>&1 >out', 'a redirect ("2>&1")'],
  ['gh pr checks 2>&1 12', 'a redirect ("2>&1")'],
  ['gh pr list 1>&2', 'a redirect ("1>&2")'],
  ['gh pr list 2>/dev/nullx', 'a redirect ("2>")'],
  ['gh pr list < in', 'a redirect ("<")'],
  ['gh pr view $(cat n)', 'expansion ("$(")'],
  ['gh pr view `id`', 'expansion ("`")'],
  ['gh pr view ${X}', 'expansion ("$")'],
  ['(git log)', '"(git"'],
  ['{ git log; }', '"{"'],
  ['gh pr list &', 'running in the background ("&")'],
  ['gh pr list & rm x', 'running in the background ("&")'],
  ['git log &&& rm x', 'running in the background ("&")'],
  ['git log -3\nrm x', 'a second line'],
  ['gh pr list --search "is:open"', 'double quotes'],
  [`gh pr view 'a'"; rm b; "'c'`, 'double quotes'],
  ['gh pr view x\\; rm y', '"x\\"'],
  // A chain is refused whole when any part isn't a read, and names that part.
  ['git log -3; rm -rf x', 'Refused part: rm -rf x'],
  ['git status && gh pr merge 12', '"gh pr merge" isn\'t a read'],
  ['git status || rm x', '"rm x" isn\'t a read'],
  ["gh pr view 'x' ; rm 'y'", '"rm y" isn\'t a read'],
  ['git log -3 && git log --output=x', '"--output=x" makes "git log" more than a read'],
  ['git log;; rm x', 'an empty command'],
  ['; rm x', 'an empty command'],
  ['git status;', 'an empty command'],
  ["/bin/zsh -lc 'git log; rm x'", '"rm x" isn\'t a read'],
  // Lookalikes for `;` and curly quotes.
  ['gh pr view x；rm y', '"x；rm"'],
  ['gh pr view x;rm y', '"x;rm"'],
  ["gh pr view 'x’; rm f; ‘y'", 'a curly quote or dash ("’"'],
  ['gh pr view 12 —web', 'a curly quote or dash ("—"'],
  // Single commands that aren't reads.
  ['gh pr merge 12', '"gh pr merge" isn\'t a read'],
  ['orca bot item add --title x', '"orca bot item add" isn\'t a read'],
  ['rm -rf x', '"rm" isn\'t a read'],
  ['FOO=1 gh pr list', '"FOO=1 gh pr list" isn\'t a read'],
  ['./gh pr list', '"./gh pr list" isn\'t a read'],
  ['gh api repos/o/r -X POST', '"gh api" isn\'t a read'],
  ['gh pr view 12 --web=true', '"gh pr view" may only read github.com'],
  ['git log --output=x', '"--output=x" makes "git log" more than a read'],
  ['git branch -D main', '"git branch" may only list branches']
]

const POWERSHELL: readonly (readonly [string, string])[] = [
  ['orca bot list', ALLOW],
  ['gh pr view 12 --repo o/r', ALLOW],
  ['git log -3; git status', ALLOW],
  ['git status && git log -3', ALLOW],
  ['gh pr checks 12 2>&1', ALLOW],
  ["gh pr list --search 'is:open draft'", ALLOW],
  ["gh pr list --author=@me --json 'number,title'", ALLOW],
  ["orca bot suggest --title 'Fix CI' --why 'It is red' --ask 'Fix it'", ALLOW],
  // Curly quotes close PowerShell strings; these dashes read as `-`.
  ["gh pr view 'x’; Remove-Item f; ‘y'", 'a curly quote or dash ("’"'],
  ["gh pr view 'x‘; Remove-Item f; ’y'", 'a curly quote or dash ("‘"'],
  ["gh pr view 'x‚; Remove-Item f; ‛y'", 'a curly quote or dash ("‚"'],
  ['gh pr view “x”', 'a curly quote or dash ("“"'],
  ['gh pr view 12 –web', 'a curly quote or dash ("–"'],
  // Windows PowerShell 5.1 re-quotes these into other arguments.
  [`gh pr view 'x" --web "y'`, "a double quote inside 'single quotes'"],
  ["gh pr view 'x\\' --web", "'x\\' (empty or ending in \\)"],
  ["gh pr view '' 12", "'' (empty or ending in \\)"],
  ['gh pr list --search "is:open"', 'double quotes'],
  // Splatting and arrays.
  ['gh pr view @args', '"@args" (splatting in PowerShell)'],
  ['gh pr list -A @me', '"@me" (splatting in PowerShell)'],
  ['gh pr view 12,--web', '"12,--web" (an array in PowerShell'],
  ['git log x,--output=f', '"x,--output=f" (an array in PowerShell'],
  // Writes, pipes and redirects.
  ['git log -3 && Remove-Item f', '"Remove-Item f" isn\'t a read'],
  ['git log; Remove-Item -Recurse x', 'Refused part: Remove-Item -Recurse x'],
  ['gh pr list; Remove-Item x', '"Remove-Item x" isn\'t a read'],
  ['Out-File -FilePath x', '"Out-File" isn\'t a read'],
  ['Set-Content x y', '"Set-Content x y" isn\'t a read'],
  ["iex 'Remove-Item x'", '"iex" isn\'t a read'],
  ['gh pr list | Out-File x', 'a pipe ("|")'],
  ['gh pr list | Set-Content x', 'a pipe ("|")'],
  ['gh pr list 2>&1 | Tee-Object x', 'a pipe ("|")'],
  ['gh pr list > out.txt', 'a redirect (">")'],
  ['gh pr list *> x', 'a redirect (">")'],
  ['gh pr list 2>$null', 'a redirect ("2>")'],
  ['gh pr list 2>/dev/null', 'a redirect ("2>")'],
  // Call operators, expansion and script blocks.
  ['& gh pr list', 'running in the background ("&")'],
  ['. gh pr list', '". gh pr list" isn\'t a read'],
  ['gh.exe pr list', '"gh.exe pr list" isn\'t a read'],
  ['gh pr view $(Remove-Item x)', 'expansion ("$(")'],
  ['gh pr view $env:X', 'expansion ("$")'],
  ['gh pr view `; Remove-Item x', 'expansion ("`")'],
  ['gh pr view (Remove-Item x)', '"(Remove-Item"'],
  ['gh pr view {Remove-Item x}', '"{Remove-Item"'],
  ['gh pr list --% x', '"--%"'],
  ['gh pr view x;Remove-Item y', '"x;Remove-Item"']
]

describe('lookAroundToolDecision', () => {
  it.each([
    ...BASH.map(([command, named]) => ['Bash', command, named] as const),
    ...POWERSHELL.map(([command, named]) => ['PowerShell', command, named] as const)
  ])('%s: %s -> %s', (tool, command, named) => {
    const answer = lookAroundToolDecision(tool, { command })
    if (named === ALLOW) {
      expect(answer).toEqual({ decision: 'allow' })
    } else {
      expect(answer.decision).toBe('deny')
      expect(answer.decision === 'deny' && answer.reason).toContain(named)
    }
  })

  it('names a refused tool', () => {
    const answer = lookAroundToolDecision('WebFetch', { url: 'https://example.com' })
    expect(answer.decision === 'deny' && answer.reason).toContain('the WebFetch tool')
  })
})
