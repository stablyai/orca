import { planAgentBinary, type CommitMessagePlanResult } from '../../shared/commit-message-plan'
import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import { OMP_MISSION_SYSTEM_PROMPT, type OmpMissionProcessFiles } from './omp-mission-process-files'

const PLANNER_OPTIONS = new Set([
  '--profile',
  '--model',
  '--provider',
  '--thinking',
  '--service-tier',
  '--api-key'
])

function hasOnlyPlannerOptions(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const [option, ...inlineValue] = args[index].split('=')
    if (!PLANNER_OPTIONS.has(option)) {
      return false
    }
    const value = inlineValue.length > 0 ? inlineValue.join('=') : args[++index]
    if (!value || value.startsWith('-')) {
      return false
    }
  }
  return true
}

export function planOmpMissionGeneration(
  prompt: string,
  commandOverride: string | undefined,
  backslash: CommandTemplateBackslash,
  files: OmpMissionProcessFiles
): CommitMessagePlanResult {
  const command = planAgentBinary('omp', commandOverride, backslash)
  if (!command.ok) {
    return command
  }
  if (!hasOnlyPlannerOptions(command.prefixArgs)) {
    return {
      ok: false,
      error:
        'OMP Mission planning supports an executable path and profile/model options only; remove command override options that enable tools, extensions or another mode.'
    }
  }

  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: [
        ...command.prefixArgs,
        '--print',
        '--mode',
        'text',
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-title',
        '--no-lsp',
        '--no-pty',
        '--config',
        files.configPath,
        '--trusted-extension',
        files.extensionPath,
        '--system-prompt',
        OMP_MISSION_SYSTEM_PROMPT
      ],
      stdinPayload: prompt,
      label: 'OMP'
    }
  }
}
