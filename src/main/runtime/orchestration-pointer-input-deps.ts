import type { TerminalRunFactsRegister } from './terminal-run-facts'
import { claudeTerminalPromptChannel } from './claude-terminal-prompt-channel'

/** What pointer delivery reads about input: the person's keystrokes, and the agent's own prompt channel. */
export function orchestrationPointerInputDeps(
  runFacts: Pick<TerminalRunFactsRegister, 'readLastDrivingInputAt'>
) {
  return {
    readLastDrivingInputAt: (ptyId: string) => runFacts.readLastDrivingInputAt(ptyId),
    resolvePromptChannel: claudeTerminalPromptChannel
  }
}
