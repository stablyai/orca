import { federationRelayWireItem } from './federation-relay-wire'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { deliverQuestionAnswer } from '../mailbox/questions/question-answer-delivery'
import { importFederatedControlMessage } from './federation-control-message'
import { OrchestrationError } from '../orchestration-error'
import {
  areFederatedLifecycleSettlementsEqual,
  publishFederatedLifecycleSettlement,
  type FederatedLifecycleSettlement
} from './federation-lifecycle-settlement'
import type { RpcMethod } from '../../rpc/core'
import { defineOrchestrationMethod } from '../../rpc/methods/orchestration/access/orchestration-method-access'
import {
  FederationAckParams,
  FederationImportParams,
  FederationPullParams
} from '../../../../shared/rpc-contract/orchestration-federation-relay-params'

export const ORCHESTRATION_FEDERATION_RELAY_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.federationPull',
    access: { kind: 'localOnly', targets: { dispatchId: 'dispatch' } },
    permission: 'workspace',
    params: FederationPullParams,
    handler: (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      return {
        dispatchId: params.dispatchId,
        runtimeEpoch: runtime.getRuntimeId(),
        items: (params.replayUnacknowledged
          ? runtime
              .getOrchestrationDb()
              .listPendingFederationRelay(params.dispatchId, 'to_home', params.limit)
          : runtime.getOrchestrationDb().listFederationRelay({
              dispatchId: params.dispatchId,
              direction: 'to_home',
              afterSequence: params.afterSequence ?? 0,
              limit: params.limit
            })
        ).map(federationRelayWireItem)
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.federationAck',
    access: { kind: 'localOnly', targets: { dispatchId: 'dispatch' } },
    permission: 'workspace',
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
        armAutoRelease: params.autoRelease === true,
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
  defineOrchestrationMethod({
    name: 'orchestration.federationImport',
    access: { kind: 'localOnly', targets: { dispatchId: 'dispatch' } },
    permission: 'workspace',
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
        db.db.exec('SAVEPOINT received_relay_item')
        let notify: (() => void) | undefined
        try {
          if (item.kind === 'reply') {
            const reply = parseFederatedReply(item.payload)
            db.answerRemoteQuestion({
              messageId: reply.questionId,
              dispatchId: params.dispatchId,
              answerMessageId: reply.answerMessageId,
              body: reply.body,
              answerSenderReport: item.answerSenderReport
            })
            notify = () =>
              deliverQuestionAnswer(runtime, {
                message_id: reply.questionId,
                dispatch_id: params.dispatchId
              })
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
              notify = () =>
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
          db.db.exec('RELEASE received_relay_item')
        } catch (error) {
          db.db.exec('ROLLBACK TO received_relay_item')
          db.db.exec('RELEASE received_relay_item')
          throw error
        }
        notify?.()
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
