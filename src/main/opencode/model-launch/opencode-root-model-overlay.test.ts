import { describe, expect, it } from 'vitest'
import {
  quoteStartupArg,
  type AgentStartupShell
} from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { planOpenCodeRootModelRewrite } from './opencode-root-model-overlay'

const q = (args: string[], shell: AgentStartupShell) =>
  args.map((arg) => quoteStartupArg(arg, shell)).join(' ')

describe('planOpenCodeRootModelRewrite', () => {
  it('keeps a PowerShell multiline prompt ending in backticks byte for byte', () => {
    const prompt = 'Use "a;b"\nthen run `pnpm test`'
    const tail = ` --prompt ${quoteStartupArg(prompt, 'powershell')}`
    expect(
      planOpenCodeRootModelRewrite(
        `& opencode ${q(['--model', 'a/b'], 'powershell')}${tail}`,
        'powershell',
        prompt
      )?.command
    ).toBe(`& opencode --standalone${tail}`)
  })

  it.each([
    ['posix', `opencode ${q(['run', '--model', 'a/b'], 'posix')}`],
    ['posix', `opencode ${q(['./pkg', '--model', 'a/b'], 'posix')}`],
    ['posix', `opencode ${q(['--server', 'http://127.0.0.1:4096', '--model', 'a/b'], 'posix')}`],
    ['posix', `opencode ${q(['-s', 'ses_1', '--model', '$MODEL'], 'posix')}`],
    // Hand-typed shapes Orca never emits keep today's behavior.
    ['posix', 'opencode --model a/b'],
    ['posix', `opencode ${q(['--model', 'a/b'], 'posix')}\n--model c/d`],
    ['posix', `opencode ${q(['--model', 'a/b'], 'posix')}; --model c/d`],
    ['posix', `opencode ${q(['--model', 'a/b'], 'posix')} --prompt # --model c/d`],
    ['posix', `$OC ${q(['--model', 'a/b'], 'posix')}`],
    ['cmd', `opencode ${q(['--model', 'a/b'], 'cmd')} --prompt "C:\\"`],
    [
      'cmd',
      `opencode ${q(['--model', 'a/b'], 'cmd')} --prompt ${quoteStartupArg('fix "a"', 'cmd')}`
    ],
    ['cmd', `opencode ${q(['--model', 'a/b'], 'cmd')} --prompt ${quoteStartupArg('x\ny', 'cmd')}`],
    ['posix', 'claude --model opus']
  ] as const)('leaves %s `%s` as typed', (shell, command) => {
    expect(planOpenCodeRootModelRewrite(command, shell, 'C:\\')).toBeNull()
  })
})
