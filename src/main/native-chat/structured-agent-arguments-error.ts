import type { AgentSessionArgumentProblem } from '../../shared/agent-session/agent-session-argument-problem'
import { findInErrorChain } from '../provider-process/provider-error-chain'

/** Expose only the option name; saved values may contain secrets. */
export class StructuredAgentArgumentsError extends Error {
  readonly argumentProblem: AgentSessionArgumentProblem

  constructor(
    agent: AgentSessionArgumentProblem['agent'],
    option: string,
    problem: AgentSessionArgumentProblem['problem']
  ) {
    const normalizedOption =
      problem === 'positionalPrompt'
        ? 'prompt'
        : (option.match(/^--[a-zA-Z][a-zA-Z0-9-]{0,63}/)?.[0] ??
          option.match(/^-[a-zA-Z]/)?.[0] ??
          '--?')
    super(`${agent} structured chat cannot use ${normalizedOption} in saved Arguments`)
    this.name = 'StructuredAgentArgumentsError'
    this.argumentProblem = { agent, option: normalizedOption, problem }
  }
}

export function argumentProblemOf(error: unknown): AgentSessionArgumentProblem | undefined {
  return findInErrorChain(error, (inner) =>
    inner instanceof StructuredAgentArgumentsError ? inner.argumentProblem : undefined
  )
}
