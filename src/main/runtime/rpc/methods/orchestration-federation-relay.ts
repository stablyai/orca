import { z } from 'zod'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import { importFederatedControlMessage } from '../../orchestration/federation-control-message'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  areFederatedLifecycleSettlementsEqual,
  publishFederatedLifecycleSettlement,
  type FederatedLifecycleSettlement
} from '../../orchestration/federation-lifecycle-settlement'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'

const FederationPullParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  afterSequence: OptionalFiniteNumber,
  replayUnacknowledged: z.boolean().optional(),
  limit: OptionalFiniteNumber
})

const FederationAckParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  throughSequence: z.number().int().nonnegative(),
  settlements: z
    .array(
      z.object({
        sequence: z.number().int().positive(),
        lifecycle: z.discriminatedUnion('action', [
          z.object({
            action: z.enum(['completed', 'failed']),
            authority: z.literal('run_home')
          }),
          z.object({
            action: z.literal('rejected'),
            code: z.string(),
            reason: z.string(),
            authority: z.literal('run_home')
          })
        ])
      })
    )
    .optional()
})

const FederationImportParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  items: z.array(
    z.object({
      dispatch_id: requiredString('Missing item Dispatch ID'),
      direction: z.literal('to_worker'),
      sequence: z.number().int().positive(),
      message_id: requiredString('Missing relay message ID'),
      kind: requiredString('Missing relay kind'),
      payload: requiredString('Missing relay payload')
    })
  )
})

export const ORCHESTRATION_FEDERATION_RELAY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationPull',
    params: FederationPullParams,
    handler: (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      return {
        dispatchId: params.dispatchId,
        runtimeEpoch: runtime.getRuntimeId(),
        items: params.replayUnacknowledged
          ? runtime
              .getOrchestrationDb()
              .listPendingFederationRelay(params.dispatchId, 'to_home', params.limit)
          : runtime.getOrchestrationDb().listFederationRelay({
              dispatchId: params.dispatchId,
              direction: 'to_home',
              afterSequence: params.afterSequence ?? 0,
              limit: params.limit
            })
      }
    }
  }),
  defineMethod({
    name: 'orchestration.federationAck',
    params: FederationAckParams,
    handler: (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      const receivedSettlements = (params.settlements ?? []).filter(
        (settlement) => settlement.sequence <= params.throughSequence
      )
      const settlementsBySequence = new Map<number, (typeof receivedSettlements)[number]>()
      for (const settlement of receivedSettlements) {
        const existing = settlementsBySequence.get(settlement.sequence)
        if (
          existing &&
          !areFederatedLifecycleSettlementsEqual(existing.lifecycle, settlement.lifecycle)
        ) {
          throw new OrchestrationError(
            'request_mismatch',
            `Federation acknowledgment for ${params.dispatchId} contains conflicting settlements.`
          )
        }
        settlementsBySequence.set(settlement.sequence, existing ?? settlement)
      }
      const settlements = [...settlementsBySequence.values()]
      const terminalSettlements = settlements.filter(
        (settlement) =>
          settlement.lifecycle.action === 'completed' || settlement.lifecycle.action === 'failed'
      )
      const terminalOutcomes = new Set(
        terminalSettlements.map((settlement) => settlement.lifecycle.action)
      )
      if (terminalOutcomes.size > 1) {
        throw new OrchestrationError(
          'request_mismatch',
          `Federation acknowledgment for ${params.dispatchId} contains conflicting settlements.`
        )
      }
      runtime.getOrchestrationDb().acknowledgeFederationRelay({
        dispatchId: params.dispatchId,
        direction: 'to_home',
        throughSequence: params.throughSequence,
        ...(settlements.length === 0
          ? {}
          : {
              settleRemoteReports: settlements.map((settlement) => ({
                sequence: settlement.sequence,
                ...(settlement.lifecycle.action === 'completed'
                  ? { outcome: 'succeeded' as const }
                  : settlement.lifecycle.action === 'failed'
                    ? { outcome: 'failed' as const }
                    : {})
              }))
            })
      })
      for (const settlement of settlements) {
        publishFederatedLifecycleSettlement(
          runtime,
          params.dispatchId,
          settlement.sequence,
          settlement.lifecycle as FederatedLifecycleSettlement
        )
      }
      return { dispatchId: params.dispatchId, acknowledgedThrough: params.throughSequence }
    }
  }),
  defineMethod({
    name: 'orchestration.federationImport',
    params: FederationImportParams,
    handler: (params, { runtime, authenticatedCallerFingerprint }) => {
      const db = runtime.getOrchestrationDb()
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      let cursor = attachment.to_worker_imported_sequence
      let imported = 0
      for (const item of params.items) {
        if (item.dispatch_id !== params.dispatchId || item.sequence > cursor + 1) {
          throw new OrchestrationError(
            'operation_unknown',
            `Home relay for ${params.dispatchId} is not contiguous after sequence ${cursor}.`
          )
        }
        if (item.sequence <= cursor) {
          continue
        }
        const currentAttachment = requireHomeAttachment(
          runtime,
          params.dispatchId,
          authenticatedCallerFingerprint
        )
        if (currentAttachment.state !== 'ready') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Remote Dispatch ${params.dispatchId} is not active.`
          )
        }
        if (item.kind === 'reply') {
          const reply = parseFederatedReply(item.payload)
          db.answerRemoteQuestion({
            messageId: reply.questionId,
            dispatchId: params.dispatchId,
            answerMessageId: reply.answerMessageId,
            body: reply.body
          })
          runtime.notifyMessageArrived(`dispatch:${params.dispatchId}`, 'status')
        } else if (item.kind === 'control_message') {
          if (
            currentAttachment.protocol_version <
            ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
          ) {
            throw new OrchestrationError(
              'capability_unsupported',
              `Remote Dispatch ${params.dispatchId} does not support coordinator control mail.`
            )
          }
          const controlMessage = importFederatedControlMessage(db, {
            dispatchId: params.dispatchId,
            messageId: item.message_id,
            payload: item.payload
          })
          imported += controlMessage.imported ? 1 : 0
          if (controlMessage.imported) {
            runtime.notifyMessageArrived(`dispatch:${params.dispatchId}`, controlMessage.type)
          }
        } else {
          throw new OrchestrationError(
            'invalid_argument',
            `Federated worker relay kind ${item.kind} is not supported.`
          )
        }
        cursor = item.sequence
        db.setRemoteWorkerImportSequence(params.dispatchId, cursor)
      }
      return { dispatchId: params.dispatchId, acknowledgedThrough: cursor, imported }
    }
  })
]

function requireHomeAttachment(
  runtime: Parameters<RpcMethod['handler']>[1]['runtime'],
  dispatchId: string,
  callerFingerprint: string | undefined
) {
  const attachment = runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
  if (!attachment || attachment.home_peer_fingerprint !== callerFingerprint) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${dispatchId} was not found for this Run home.`
    )
  }
  return attachment
}

function parseFederatedReply(payload: string): {
  questionId: string
  answerMessageId: string
  body: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new OrchestrationError('invalid_argument', 'Federated reply payload is invalid JSON.')
  }
  const reply = parsed as Record<string, unknown> | null
  if (
    !reply ||
    typeof reply.questionId !== 'string' ||
    typeof reply.answerMessageId !== 'string' ||
    typeof reply.body !== 'string'
  ) {
    throw new OrchestrationError('invalid_argument', 'Federated reply payload is incomplete.')
  }
  return {
    questionId: reply.questionId,
    answerMessageId: reply.answerMessageId,
    body: reply.body
  }
}
