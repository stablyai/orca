import { describe, expect, it } from 'vitest'
import { planOpenCodeRootModelRewrite } from './opencode-root-model-overlay'

describe('planOpenCodeRootModelRewrite', () => {
  it.each([
    ["opencode '--model' 'opencode/big-pickle'", 'opencode --standalone', 'opencode/big-pickle'],
    [
      'opencode --model=anthropic/claude-opus-5-5',
      'opencode --standalone',
      'anthropic/claude-opus-5-5'
    ],
    [
      "opencode -m openai/gpt-5.3-codex --prompt 'fix it'",
      "opencode --standalone --prompt 'fix it'",
      'openai/gpt-5.3-codex'
    ],
    ['opencode --standalone --model a/b --model c/d', 'opencode --standalone', 'c/d']
  ])('moves the root model out of %s', (command, rewritten, model) => {
    expect(planOpenCodeRootModelRewrite(command, 'posix')).toMatchObject({
      command: rewritten,
      model
    })
  })

  it('handles a PowerShell call operator', () => {
    expect(
      planOpenCodeRootModelRewrite("& 'opencode.exe' --model opencode/big-pickle", 'powershell')
    ).toMatchObject({ command: "& 'opencode.exe' --standalone", model: 'opencode/big-pickle' })
  })

  it.each([
    'opencode',
    'opencode run --model a/b hi',
    'opencode mini --model a/b',
    'opencode ./pkg --model a/b',
    'opencode --server http://127.0.0.1:4096 --model a/b',
    'opencode --model "$MODEL"',
    "opencode --prompt '-make the build pass'",
    'opencode --model --prompt hi',
    'claude --model opus'
  ])('leaves %s unchanged', (command) => {
    expect(planOpenCodeRootModelRewrite(command, 'posix')).toBeNull()
  })

  it('probes the primary agent only when other root options cannot change it', () => {
    expect(
      planOpenCodeRootModelRewrite("opencode --model a/b --prompt 'hi'", 'posix')
    ).toMatchObject({ probeExecutable: 'opencode' })
    for (const command of ['opencode --model a/b --unknown', 'opencode --model a/b -s ses_1']) {
      expect(planOpenCodeRootModelRewrite(command, 'posix')?.probeExecutable).toBeUndefined()
    }
  })
})
