import type { AgentUpdateInfo, UpdateStep } from '../../shared/agent-updates/agent-update-types'
import type { ResolvedAgentBinary } from './agent-binary'

/** A bare `program` (npm) is resolved to an absolute path on the local PATH by the runner. */
export type UpdatePlan =
  | { kind: 'process'; program: string; args: string[] }
  | { kind: 'manual'; command: string }

function runsOn(step: UpdateStep, platform: NodeJS.Platform): boolean {
  return step.via !== 'manual' || !step.platforms || step.platforms.includes(platform)
}

// Why: `npm install -g` only owns npm global installs; pnpm/bun/yarn or native installs need their own tool.
function applies(step: UpdateStep, resolved: ResolvedAgentBinary, platform: NodeJS.Platform) {
  switch (step.via) {
    case 'manual':
      return runsOn(step, platform)
    case 'npm':
      return (step.when ?? ['npm']).includes(resolved.installMethod)
    case 'self':
      return !step.when || step.when.includes(resolved.installMethod)
  }
}

function planStep(step: UpdateStep, resolved: ResolvedAgentBinary): UpdatePlan {
  switch (step.via) {
    case 'self':
      return { kind: 'process', program: resolved.binary, args: [...step.args] }
    case 'npm': {
      const prefix = resolved.npmPrefix ? ['--prefix', resolved.npmPrefix] : []
      return {
        kind: 'process',
        program: 'npm',
        args: ['install', '-g', ...prefix, `${step.pkg}@latest`]
      }
    }
    case 'manual':
      return { kind: 'manual', command: step.command }
  }
}

function shellWord(word: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(word)) {
    return word
  }
  return platform === 'win32' ? `"${word}"` : `'${word.replaceAll("'", `'\\''`)}'`
}

/** Null when Orca must not act: a Homebrew install, or no step or safe hint for this install. */
export function planAgentUpdate(
  info: AgentUpdateInfo,
  resolved: ResolvedAgentBinary,
  platform: NodeJS.Platform
): UpdatePlan | null {
  // Why: Homebrew owns its installs; Orca neither runs nor suggests anything for them.
  if (resolved.installMethod === 'brew') {
    return null
  }
  const step = info.update.find((candidate) => applies(candidate, resolved, platform))
  if (step) {
    return planStep(step, resolved)
  }
  // Why: an npm hint for a non-npm install would be a wrong copy-paste command.
  const fallback = info.update.find(
    (candidate) => candidate.via !== 'npm' && runsOn(candidate, platform)
  )
  if (!fallback) {
    return null
  }
  // Why: an install method outside every `when` gets a copyable hint instead of a run button.
  const plan = planStep(fallback, resolved)
  if (plan.kind === 'manual') {
    return plan
  }
  const words = [plan.program, ...plan.args].map((word) => shellWord(word, platform))
  // PowerShell runs a (quoted) program path only through the `&` call operator.
  return { kind: 'manual', command: `${platform === 'win32' ? '& ' : ''}${words.join(' ')}` }
}
