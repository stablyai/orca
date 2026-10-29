import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import type {
  PRCheckAnnotation,
  PRCheckJob,
  PRCheckRunDetails,
  PRCheckStep
} from '../../../src/shared/github/check-types'
import { prCount, prText } from './github-pr-entity-reply-schema'

// Require check name; default optional details because hosts may omit fields the panel renders unguarded.

const checkAnnotationSchema = z
  .looseObject({
    path: prText('path'),
    startLine: prCount('startLine'),
    endLine: prCount('endLine'),
    annotationLevel: prText('annotationLevel'),
    title: prText('title'),
    message: prText('message'),
    rawDetails: prText('rawDetails')
  })
  .transform((annotation): PRCheckAnnotation => ({
    path: annotation.path ?? null,
    startLine: annotation.startLine ?? null,
    endLine: annotation.endLine ?? null,
    annotationLevel: annotation.annotationLevel ?? null,
    title: annotation.title ?? null,
    message: annotation.message ?? '',
    rawDetails: annotation.rawDetails ?? null
  }))

const checkStepSchema = z
  .looseObject({
    name: prText('name'),
    status: prText('status'),
    conclusion: prText('conclusion'),
    startedAt: prText('startedAt'),
    completedAt: prText('completedAt')
  })
  .transform((step): PRCheckStep => ({
    name: step.name ?? '',
    status: step.status ?? null,
    conclusion: step.conclusion ?? null,
    startedAt: step.startedAt ?? null,
    completedAt: step.completedAt ?? null
  }))

const checkJobSchema = z
  .looseObject({
    id: prCount('id'),
    name: prText('name'),
    status: prText('status'),
    conclusion: prText('conclusion'),
    startedAt: prText('startedAt'),
    completedAt: prText('completedAt'),
    url: prText('url'),
    logTail: prText('logTail'),
    logState: salvagedOptional(
      'logState',
      z.enum(['available', 'empty', 'error', 'not_requested'])
    ),
    steps: salvagedOptional('steps', salvagingArray(checkStepSchema))
  })
  .transform((job): PRCheckJob => ({
    id: job.id ?? null,
    name: job.name ?? '',
    status: job.status ?? null,
    conclusion: job.conclusion ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    url: job.url ?? null,
    logTail: job.logTail ?? null,
    ...(job.logState === undefined ? {} : { logState: job.logState }),
    steps: job.steps ?? []
  }))

export const githubPrCheckDetailsSchema = z
  .looseObject({
    name: prText('name'),
    status: prText('status'),
    conclusion: prText('conclusion'),
    url: prText('url'),
    detailsUrl: prText('detailsUrl'),
    startedAt: prText('startedAt'),
    completedAt: prText('completedAt'),
    title: prText('title'),
    summary: prText('summary'),
    text: prText('text'),
    annotations: salvagedOptional('annotations', salvagingArray(checkAnnotationSchema)),
    jobs: salvagedOptional('jobs', salvagingArray(checkJobSchema))
  })
  .transform((run): PRCheckRunDetails | null =>
    run.name === undefined
      ? null
      : {
          name: run.name,
          status: run.status ?? null,
          conclusion: run.conclusion ?? null,
          url: run.url ?? null,
          detailsUrl: run.detailsUrl ?? null,
          startedAt: run.startedAt ?? null,
          completedAt: run.completedAt ?? null,
          title: run.title ?? null,
          summary: run.summary ?? null,
          text: run.text ?? null,
          annotations: run.annotations ?? [],
          jobs: run.jobs ?? []
        }
  )
  .nullable()
