import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import {
  nativeChatSideQuestionAgentId,
  nativeChatSideQuestionModelId,
  nativeChatSideQuestionReadOnlyArgs
} from '../../shared/native-chat-btw'
import {
  commandBackslashMode,
  executeGenerationPlan
} from '../text-generation/source-control-text-generation-requests'
import { spawnSourceControlAgent } from '../text-generation/source-control-agent-launch'
import type { CommitMessageGenerationTarget } from '../text-generation/source-control-text-generation-types'

export { nativeChatSideQuestionAgentId } from '../../shared/native-chat-btw'

export async function generateNativeChatSideQuestion(input: {
  agent: string
  question: string
  prompt: string
  cwd: string
  model?: string
  agentCommandOverride?: string
  target?: CommitMessageGenerationTarget
}): Promise<{ success: true; answer: string } | { success: false; error: string }> {
  const question = input.question.trim()
  if (!question) {
    return { success: false, error: 'Ask a side question after /btw.' }
  }
  const agentId = nativeChatSideQuestionAgentId(input.agent)
  if (!agentId) {
    return { success: false, error: '/btw is not available for this agent.' }
  }
  const model = nativeChatSideQuestionModelId(agentId, input.model)
  if (!model) {
    return { success: false, error: '/btw is not available for this agent.' }
  }
  const target = input.target ?? { kind: 'local', cwd: input.cwd }
  const planned = planCommitMessageGeneration(
    {
      agentId,
      model,
      ...(input.agentCommandOverride ? { agentCommandOverride: input.agentCommandOverride } : {}),
      backslash: commandBackslashMode(target)
    },
    input.prompt
  )
  if (!planned.ok) {
    return { success: false, error: planned.error }
  }
  const plan = {
    ...planned.plan,
    args: nativeChatSideQuestionReadOnlyArgs(agentId, planned.plan.args)
  }
  const result = await executeGenerationPlan({
    params: {
      agentId,
      model
    },
    plan,
    target,
    emptyResultName: 'side question',
    operation: 'side-question',
    spawnAgent: spawnSourceControlAgent
  })
  if (!result.success) {
    return { success: false, error: result.error }
  }
  const answer = result.rawOutput.trim()
  return answer
    ? { success: true, answer }
    : { success: false, error: 'The side question returned an empty answer.' }
}
