import { PipelineStageEvidence } from '../../../shared/pipelines/pipeline-stage-evidence'
import type { PipelineCommand, PipelineRun } from '../../../shared/pipelines/pipeline-contracts'

export function requirePipelineAgentEvidence(
  run: PipelineRun,
  command: Extract<PipelineCommand, { kind: 'submit' }>
): void {
  if (command.verdict === 'blocked') {
    return
  }
  const evidence = PipelineStageEvidence.parse(command.evidence)
  if (
    evidence.stage !== run.stage ||
    JSON.stringify(evidence).length + command.body.length > 12000
  ) {
    throw new Error('pipeline_stage_evidence_mismatch')
  }
  if (evidence.stage === 'review') {
    if (command.verdict === 'changes_requested' && evidence.findings.length === 0) {
      throw new Error('pipeline_review_findings_required')
    }
    if (
      command.verdict === 'pass' &&
      evidence.findings.some((finding) => finding.severity !== 'minor')
    ) {
      throw new Error('pipeline_review_unresolved_findings')
    }
  }
}

export function pipelineStageInstruction(stage: PipelineRun['stage']): string {
  const evidence = {
    plan: '{"stage":"plan","criteria":["acceptance criterion"],"steps":["bounded implementation step"]}',
    implement: '{"stage":"implement","changes":["path and concrete change"]}',
    fix: '{"stage":"fix","changes":["finding and its fix"]}',
    docs: '{"stage":"docs","files":["README.md"],"rationale":"optional; required when files is empty"}',
    review:
      '{"stage":"review","findings":[{"severity":"important","detail":"concrete defect","conditionToFix":"verifiable fix condition","path":"src/file.ts"}]}',
    checks: ''
  }[stage]
  return `Perform only ${stage}. Preserve the task criteria. Submission command must contain evidence shaped as ${evidence}. Evidence is at most 4000 characters; body plus evidence is at most 12000. ${
    stage === 'review'
      ? 'Review the pinned clean commit independently without repository edits. PASS requires no critical/important findings; changes_requested requires concrete findings and conditions to fix. Use an empty findings array for PASS without findings.'
      : stage === 'docs'
        ? 'After documenting, create the task commit through the repository’s authorized workflow, obeying its check and permission rules. Commit only task changes. Review requires a clean commit; if authorization is missing return blocked. Do not merge or deploy.'
        : 'Report concrete changes, decisions and limitations. The runtime performs configured checks after implementation.'
  }`
}
