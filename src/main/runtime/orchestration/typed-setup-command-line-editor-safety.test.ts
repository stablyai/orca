import { describe, expect, it } from 'vitest'
import {
  typeThroughZshAutopair,
  ZSH_AUTOPAIR_REPORTED_18059_CORRUPTION
} from '../../../shared/__fixtures__/zsh-autopair-keystroke-model'
import { createSequencedSetupAgentCommands } from '../../../shared/setup-agent-sequencing'
import { buildSetupRunnerCommand } from '../../../shared/setup-runner-command'
import { buildStartupCommandSubmission } from '../../../shared/startup-command-submission'
import { buildObservedSetupCommand } from './setup-completion-signal'

const RUNNER_PATH = '/repo/.git/orca/setup-runner.sh'

function generatedTypedCommands(): Record<string, string> {
  const sequenced = createSequencedSetupAgentCommands({
    runnerScriptPath: RUNNER_PATH,
    startupCommand: 'codex',
    platform: 'posix',
    nonce: 'nonce-ratchet'
  })
  return {
    'observed setup': buildObservedSetupCommand(RUNNER_PATH, 'posix', 'token-ratchet').command,
    'sequenced setup': sequenced.setupCommand,
    'sequenced startup': sequenced.startupCommand,
    'plain setup runner': buildSetupRunnerCommand(RUNNER_PATH, 'posix')
  }
}

describe('typed setup commands survive a pair-inserting line editor', () => {
  // Why this anchor first: the round-trip assertions below only mean something if the model still
  // reproduces the corruption the issue reported.
  it('models the corruption reported in #18059', () => {
    expect(typeThroughZshAutopair(ZSH_AUTOPAIR_REPORTED_18059_CORRUPTION.typed)).toBe(
      ZSH_AUTOPAIR_REPORTED_18059_CORRUPTION.corrupted
    )
  })

  it.each(Object.entries(generatedTypedCommands()))(
    'types the %s command into zsh-autopair unchanged',
    (_name, command) => {
      const submitted = buildStartupCommandSubmission(command, {
        submit: '\n',
        bracketedPasteSafe: false
      })

      expect(typeThroughZshAutopair(submitted)).toBe(command)
    }
  )
})
