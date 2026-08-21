import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'prepare-codex'],
    summary: 'Repair MCode-managed Codex hook trust before a shell launch',
    usage: 'mcode agent hooks prepare-codex',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether MCode-managed agent status hooks are enabled',
    usage: 'mcode agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['mcode agent hooks status', 'mcode agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable MCode-managed agent status hooks and remove local hook entries',
    usage: 'mcode agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['mcode agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable MCode-managed agent status hooks',
    usage: 'mcode agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['mcode agent hooks on']
  }
]
