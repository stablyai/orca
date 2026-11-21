import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'

export const TEXT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['text', 'generate'],
    summary: 'Ask an agent for one answer, without tools, using the accounts Orca manages',
    usage:
      'orca text generate --agent <id> (--prompt <text> | --prompt-file <path|->) [--model <id>] [--effort <level>] [--timeout-ms <ms>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'agent',
      'model',
      'effort',
      'prompt',
      'prompt-file',
      'timeout-ms'
    ],
    notes: [
      'Runs the agent CLI once on the Orca host, the way Orca writes commit messages: no tools, no hooks, no MCP servers, in an empty temporary folder that is removed afterwards.',
      'The agent signs in with the account Orca has selected for it; no worktree, terminal, or worker is created.',
      '--agent takes an agent that Orca can generate text with, such as claude, codex, antigravity, cursor, or opencode. --model defaults to the agent’s default text-generation model.',
      '--prompt-file - reads the prompt from stdin. Prompts are capped at 200,000 characters.',
      'Prints the answer as plain text; --json prints { text, agent, model, elapsedMs }. Failures exit non-zero with code generation_failed, timeout, or canceled.',
      '--timeout-ms stops the agent after that long (default 5 minutes, at most 30).'
    ],
    examples: [
      'orca text generate --agent claude --model haiku --prompt "Summarize: ..."',
      'git diff | orca text generate --agent codex --prompt-file - --json'
    ]
  }
]
