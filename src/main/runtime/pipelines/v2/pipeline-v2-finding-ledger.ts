import type { z } from 'zod'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import {
  pipelineV2FindingId,
  type PipelineV2FindingLedger
} from '../../../../shared/pipelines/v2/pipeline-v2-findings'

type Finding = z.infer<typeof PipelineV2FindingLedger>['findings'][number]

export function pipelineV2FindingLedger(
  run: PipelineV2Run,
  source: string,
  sourceVerified: boolean
): z.infer<typeof PipelineV2FindingLedger> {
  const findings = new Map<string, Finding & { updatedAt: number }>()
  const accepted = new Set(
    run.visits.flatMap((visit) => (visit.acceptedCandidateId ? [visit.acceptedCandidateId] : []))
  )
  for (const [index, candidate] of run.candidates.entries()) {
    const evidence = candidate.result.evidence
    if (evidence?.stage === 'review') {
      for (const finding of evidence.findings) {
        const id = pipelineV2FindingId(finding)
        const previous = findings.get(id)
        const severity =
          previous?.severity === 'critical' || finding.severity === 'critical'
            ? 'critical'
            : previous?.severity === 'important' || finding.severity === 'important'
              ? 'important'
              : 'minor'
        findings.set(id, {
          id,
          candidateId: candidate.id,
          severity,
          detail: finding.detail.slice(0, 180),
          conditionToFix: finding.conditionToFix.slice(0, 180),
          disposition: 'open',
          proposedFixed: false,
          ownerAcknowledged: false,
          updatedAt: index
        })
      }
    }
    if (!accepted.has(candidate.id)) {
      continue
    }
    for (const update of candidate.result.findingUpdates ?? []) {
      const finding = findings.get(update.id)
      if (!finding) {
        continue
      }
      const laterReview = run.candidates.some(
        (review, reviewIndex) =>
          reviewIndex > index &&
          accepted.has(review.id) &&
          review.sourceRevision === source &&
          review.result.evidence?.stage === 'review' &&
          !review.result.evidence.findings.some((item) => pipelineV2FindingId(item) === finding.id)
      )
      const verified =
        update.disposition === 'fixed' &&
        sourceVerified &&
        candidate.sourceRevision === source &&
        laterReview
      const visit = run.visits.find((value) => value.id === candidate.visitId)
      const ownerAcknowledged =
        update.disposition === 'disputed' &&
        Boolean(
          visit &&
          run.definition.stages.find((value) => value.id === visit.stageId)?.ownerGate.enabled
        )
      findings.set(update.id, {
        ...finding,
        disposition: verified
          ? 'fixed_verified'
          : update.disposition === 'disputed'
            ? 'disputed'
            : 'open',
        rationale: update.rationale.slice(0, 180),
        requirement: update.requirement?.slice(0, 180),
        proposedFixed: update.disposition === 'fixed' && !verified,
        ownerAcknowledged,
        updatedAt: index
      })
    }
  }
  const values = [...findings.values()].sort(
    (a, b) =>
      Number(a.disposition === 'fixed_verified') - Number(b.disposition === 'fixed_verified') ||
      a.updatedAt - b.updatedAt
  )
  return {
    total: values.length,
    omitted: Math.max(0, values.length - 24),
    unresolvedImportant: values.filter(
      (finding) =>
        finding.severity !== 'minor' &&
        finding.disposition !== 'fixed_verified' &&
        !(finding.disposition === 'disputed' && finding.ownerAcknowledged)
    ).length,
    findings: values.slice(0, 24).map(({ updatedAt: _index, ...finding }) => finding)
  }
}
