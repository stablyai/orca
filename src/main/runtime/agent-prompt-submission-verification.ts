export const AGENT_PROMPT_EFFECT_TIMEOUT_MS = 5_000
const AGENT_PROMPT_EFFECT_POLL_MS = 50

export type AgentPromptActivity = Readonly<{
  generation: number
  permissionSequence: number
  workingSequence: number
  status: 'working' | 'permission' | 'idle' | null
}>

type AgentPromptVerificationOptions = {
  baseline: AgentPromptActivity
  readActivity: () => AgentPromptActivity
  signal?: AbortSignal
}

export async function verifyAgentPromptSubmission(
  options: AgentPromptVerificationOptions
): Promise<void> {
  throwIfAgentPromptAborted(options.signal)
  assertPromptNotBlocked(options.baseline, options.baseline)

  const deadline = Date.now() + AGENT_PROMPT_EFFECT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const current = options.readActivity()
    assertSamePromptGeneration(options.baseline, current)
    assertPromptNotBlocked(options.baseline, current)
    if (agentPromptLifecycleChanged(options.baseline, current)) {
      return
    }
    await waitForAgentPromptPoll(options.signal)
  }

  const current = options.readActivity()
  assertSamePromptGeneration(options.baseline, current)
  assertPromptNotBlocked(options.baseline, current)
  if (agentPromptLifecycleChanged(options.baseline, current)) {
    return
  }
  throw new Error('agent_prompt_stalled')
}

function agentPromptLifecycleChanged(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): boolean {
  return current.workingSequence > baseline.workingSequence
}

function assertSamePromptGeneration(
  baseline: AgentPromptActivity,
  current: AgentPromptActivity
): void {
  if (current.generation !== baseline.generation) {
    throw new Error('terminal_handle_stale')
  }
}

function assertPromptNotBlocked(baseline: AgentPromptActivity, current: AgentPromptActivity): void {
  if (current.status === 'permission' || current.permissionSequence > baseline.permissionSequence) {
    throw new Error('agent_prompt_blocked')
  }
}

function throwIfAgentPromptAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
}

async function waitForAgentPromptPoll(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, AGENT_PROMPT_EFFECT_POLL_MS))
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, AGENT_PROMPT_EFFECT_POLL_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}
