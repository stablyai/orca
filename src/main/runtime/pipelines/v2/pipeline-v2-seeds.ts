import { PipelineProfile } from '../../../../shared/pipelines/pipeline-contracts'
import {
  PipelineV2Template,
  type PipelineV2Stage
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'

type SeedRole = PipelineProfile['roles']['primary']
type SeedExecutor = Extract<PipelineV2Stage, { kind: 'agent' }>['executor']

function executor(role: SeedRole = { agent: 'codex' }, independent = false): SeedExecutor {
  return {
    agent: role.agent,
    model: role.model ? { kind: 'explicit', id: role.model } : { kind: 'default' },
    ...(role.effort ? { effort: role.effort } : {}),
    surface: 'chat',
    permissionMode: 'own',
    session: independent ? { kind: 'fresh' } : { kind: 'reuse', groupId: 'primary' }
  }
}
function agent(
  id: string,
  title: string,
  instructions: string,
  evidenceSchema: Extract<PipelineV2Stage, { kind: 'agent' }>['evidenceSchema'],
  role?: SeedRole,
  independent = false
): Extract<PipelineV2Stage, { kind: 'agent' }> {
  return {
    id,
    title,
    kind: 'agent',
    instructions,
    expectedResult: 'An explained result with the configured evidence.',
    evidenceSchema,
    independent,
    executor: executor(role, independent),
    inputs: { task: true, stageIds: [] },
    ownerGate: { enabled: false, reworkTargetStageId: id },
    maxReentries: 2,
    outcomes: [
      {
        id: 'done',
        title: 'Done',
        criterion: 'The expected result is complete',
        target: { kind: 'next' }
      }
    ]
  }
}
export function codingPipelineV2Seed(
  projectId: string,
  profile?: PipelineProfile
): PipelineV2Template {
  const cycles = profile?.maxFixCycles ?? 2
  const hasFix = cycles > 0
  const plan = agent(
    'plan',
    'Plan',
    'Study the task and propose a concrete implementation plan. Do not implement the plan or edit source. Respond in the task language.',
    'plan',
    profile?.roles.primary
  )
  plan.ownerGate.enabled = !profile
  const implement = agent(
    'implement',
    'Implementation',
    'Implement the accepted plan. Record completed work and verification evidence. Follow repository checks and commit only task changes before submitting, so review can pin a clean commit. If commit authorization is missing, report blocked. Never merge or deploy.',
    'changes',
    profile?.roles.primary
  )
  implement.inputs.stageIds = ['plan']
  const checks: Extract<PipelineV2Stage, { kind: 'checks' }> = {
    id: 'checks',
    title: 'Checks',
    kind: 'checks',
    instructions: '',
    expectedResult: 'All configured checks pass on the current source.',
    executor: { checkIds: profile?.checks ?? ['test'] },
    inputs: { task: false, stageIds: ['implement', ...(hasFix ? ['fix'] : [])] },
    ownerGate: { enabled: false, reworkTargetStageId: 'checks' },
    maxReentries: cycles,
    checkOutcomeMap: { passed: 'passed', failed: 'failed' },
    outcomes: [
      {
        id: 'passed',
        title: 'Passed',
        criterion: 'Every configured process passed',
        target: { kind: 'stage', stageId: 'review' }
      },
      {
        id: 'failed',
        title: 'Failed',
        criterion: 'A configured process failed',
        target: { kind: 'stage', stageId: hasFix ? 'fix' : 'checks' }
      }
    ]
  }
  const review = agent(
    'review',
    'Independent review',
    'Review the pinned clean commit independently. Do not edit it. Report critical and important findings; approve only with none.',
    'review',
    profile?.roles.reviewer,
    true
  )
  review.inputs.stageIds = ['plan', 'implement', 'checks', ...(hasFix ? ['fix'] : [])]
  review.maxReentries = cycles
  review.outcomes = [
    {
      id: 'approved',
      title: 'Approved',
      criterion: 'No critical or important findings remain',
      target: { kind: 'stage', stageId: 'docs' }
    },
    {
      id: 'changes',
      title: 'Changes requested',
      criterion: 'Actionable review findings remain',
      target: { kind: 'stage', stageId: hasFix ? 'fix' : 'review' }
    }
  ]
  const fix = agent(
    'fix',
    'Fix findings',
    'Address the latest check failures and review findings. Preserve the task scope and explain each fix. Follow repository checks and commit only task changes before submitting, so review can pin a clean commit. If commit authorization is missing, report blocked. Never merge or deploy.',
    'changes',
    profile?.roles.primary
  )
  fix.inputs.stageIds = ['checks', 'review']
  fix.maxReentries = Math.max(0, cycles - 1)
  fix.outcomes[0].target = { kind: 'stage', stageId: 'checks' }
  const docs = agent(
    'docs',
    'Documentation',
    'Document useful behavior or operational changes. If no update is useful, give a concrete rationale. Follow repository checks and commit useful documentation changes before submitting; they will go through checks and independent review again. If commit authorization is missing, report blocked. Never merge, deploy, or make unrelated edits.',
    'docs',
    profile?.roles.primary
  )
  docs.inputs.stageIds = ['implement', 'checks', 'review', ...(hasFix ? ['fix'] : [])]
  docs.outcomes = [
    {
      id: 'documented',
      title: 'Documented',
      criterion: 'Useful changes are documented',
      target: { kind: 'finish' }
    },
    {
      id: 'no_update',
      title: 'No update needed',
      criterion: 'No useful documentation change is needed, with a rationale',
      target: { kind: 'finish' }
    }
  ]
  return PipelineV2Template.parse({
    schemaVersion: 2,
    id: profile?.id ?? 'coding',
    projectId,
    version: '1',
    title: profile?.title ?? 'Development with independent review',
    description: profile?.description ?? 'Plan, implement, check, review, fix and document.',
    entryStageId: 'plan',
    stages: [plan, implement, checks, review, ...(hasFix ? [fix] : []), docs],
    limits: { maxInvocations: 128, maxDiscussionTurns: 32 },
    completionPolicy: {
      kind: 'reviewed_source',
      checkRequirements: [{ stageId: 'checks', checkIds: checks.executor.checkIds }],
      reviewRequirements: [{ stageId: 'review', acceptedOutcomeIds: ['approved'] }],
      repairEntryStageId: 'checks'
    }
  })
}
export function researchPipelineV2Seed(projectId: string): PipelineV2Template {
  const plan = agent(
    'plan',
    'Research plan',
    'Clarify the question, scope and source requirements. Respond in the task language.',
    'generic'
  )
  plan.ownerGate.enabled = true
  const research = agent(
    'research',
    'Research',
    'Investigate the question and record sources, uncertainty and relevant findings.',
    'generic'
  )
  research.inputs.stageIds = ['plan']
  const result = agent(
    'result',
    'Synthesis',
    'Synthesize the research into a useful answer, separating supported findings from uncertainty.',
    'generic'
  )
  result.inputs.stageIds = ['plan', 'research']
  result.outcomes = [
    {
      id: 'complete',
      title: 'Complete',
      criterion: 'The research question is answered',
      target: { kind: 'finish' }
    },
    {
      id: 'more_research',
      title: 'More research',
      criterion: 'Important questions remain',
      target: { kind: 'stage', stageId: 'research' }
    }
  ]
  return PipelineV2Template.parse({
    schemaVersion: 2,
    id: 'research',
    projectId,
    version: '1',
    title: 'Research and synthesis',
    description: 'A configurable research workflow.',
    entryStageId: 'plan',
    stages: [plan, research, result],
    limits: { maxInvocations: 128, maxDiscussionTurns: 32 },
    completionPolicy: { kind: 'workflow_complete' }
  })
}
export function clonePipelineV1ToV2(rawProfile: unknown, projectId: string): PipelineV2Template {
  return codingPipelineV2Seed(projectId, PipelineProfile.parse(rawProfile))
}
