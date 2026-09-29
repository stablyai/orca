import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolveProjectCreateRepoSelector } from '../worktree-project-target'

export function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string,
  options: { allowEmpty?: boolean } = {}
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && (options.allowEmpty || value.length > 0)) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

export function getOptionalStartupAgent(flags: Map<string, string | boolean>): string | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    if (flags.has('prompt')) {
      throw new RuntimeClientError('invalid_argument', '--prompt requires --agent')
    }
    return undefined
  }
  if (!isTuiAgent(agent)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${agent}"`)
  }
  return agent
}

export function getOptionalSetupDecision(
  flags: Map<string, string | boolean>
): 'run' | 'skip' | 'inherit' | undefined {
  const setup = getPresentStringFlag(flags, 'setup')
  if (setup !== undefined && setup !== 'run' && setup !== 'skip' && setup !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--setup must be one of: run, skip, inherit')
  }
  if (flags.get('run-hooks') === true) {
    if (setup !== undefined && setup !== 'run') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose either --run-hooks or --setup run, not contradictory setup flags.'
      )
    }
    return setup
  }
  return setup
}

function getRepoSelectorFromWorktreeSelector(selector: string | undefined): string | undefined {
  if (!selector?.startsWith('id:')) {
    return undefined
  }
  const worktreeId = selector.slice('id:'.length)
  const separatorIndex = worktreeId.indexOf('::')
  if (separatorIndex <= 0) {
    return undefined
  }
  return `id:${worktreeId.slice(0, separatorIndex)}`
}

export async function getCreateRepoSelector(
  flags: Map<string, string | boolean>,
  cwdParentWorktree: string | undefined,
  client: Parameters<CommandHandler>[0]['client']
): Promise<string> {
  const projectRepoSelector = await resolveProjectCreateRepoSelector(flags, client)
  if (projectRepoSelector) {
    return projectRepoSelector
  }
  const explicitRepo = getPresentStringFlag(flags, 'repo')
  if (explicitRepo) {
    return explicitRepo
  }
  const inferredRepo = getRepoSelectorFromWorktreeSelector(cwdParentWorktree)
  if (inferredRepo) {
    return inferredRepo
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Missing repo selector. Pass --repo or run from inside an Orca-managed worktree.'
  )
}
