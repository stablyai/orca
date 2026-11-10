import { attachCrewMutationNotifications } from '../crew/crew-mutation-notifications'
import { attachAttemptObservationStore } from './attempt-observation-store'
import { attachCoordinatorRunStore } from './coordinator-runs/coordinator-run-store'
import { attachDecisionGateStore } from './decision-gates/decision-gate-store'
import { attachDispatchCompletion } from './dispatch-context/dispatch-completion'
import { attachDispatchContextStore } from './dispatch-context/dispatch-context-store'
import { attachDispatchLookup } from './dispatch-context/dispatch-lookup'
import { attachDispatchDepth } from './dispatch-depth'
import { attachWorkerReportSettlement } from './dispatch-context/worker-report-settlement'
import { attachFederationRelayAck } from './federation/federation-relay-ack'
import { attachLegacyRemoteDbMethods } from '../legacy-remote/legacy-remote-db-methods'
import { attachLegacyRemoteHomeDbMethods } from '../legacy-remote-home/legacy-remote-home-db-methods'
import { attachPeerMailStore } from './federation/peer-mail-store'
import { attachLegacyAskOperation } from './legacy/legacy-ask-operation'
import { attachLegacyCompatibilityCandidates } from './legacy/legacy-compatibility-candidates'
import { attachLegacyCompatibilityPrincipals } from './legacy/legacy-compatibility-principals'
import { attachLegacyLifecycleOperation } from './legacy/legacy-lifecycle-operation'
import { attachLegacyMailAcknowledge } from './legacy/legacy-mail-acknowledge'
import { attachLegacyQuestionAcknowledge } from './legacy/legacy-question-acknowledge'
import { attachLegacyQuestionLookup } from './legacy/legacy-question-lookup'
import { attachLegacyRecoveryCohort } from './legacy/legacy-recovery-cohort'
import { attachLegacyReplyOperation } from './legacy/legacy-reply-operation'
import { attachLegacyWorkerCompletion } from './legacy/legacy-worker-completion'
import { attachDirectMailboxRouting } from './messages/direct-mailbox-routing'
import { attachForeignDirectMailboxRouting } from './messages/foreign-direct-mailbox-routing'
import { attachMailboxPointerEnterState } from './messages/mailbox-pointer-enter-state'
import { attachMessageInbox } from './messages/message-inbox'
import { attachMessageInsert } from './messages/message-insert'
import { attachRoleMailboxDelivery } from './messages/role-mailbox-delivery'
import { attachStructuredMailSendStore } from './messages/structured-mail-send-store'
import { attachMutationReceiptStore } from './mutation-receipts/mutation-receipt-store'
import { attachLifecycleTransition } from './lifecycle-transition'
import { attachQuestionThreads } from './questions/question-threads'
import { attachOrchestrationReset } from './reset/orchestration-reset'
import { attachRunBinding } from './runs/run-binding'
import { attachRunCoordinatorMailRouting } from './runs/run-coordinator-mail-routing'
import { attachRunCreate } from './runs/run-create'
import { attachRunDelivery } from './runs/run-delivery'
import { attachRunLookup } from './runs/run-lookup'
import { attachLegacyCoordinatorMailTakeover } from './runs/legacy-coordinator-mail-takeover'
import { attachAdoptLegacyRun } from './schema/adopt-legacy-run'
import { attachBackfillLegacyQuestionThreads } from './schema/backfill-legacy-question-threads'
import { attachCreateTables } from './schema/create-tables'
import { attachMigrateLegacyContractStorage } from './schema/migrate-legacy-contract-storage'
import { attachSchemaMigrate } from './schema/migrate'
import { attachSchemaColumnProbes } from './schema/schema-column-probes'
import { attachTaskStore } from './tasks/task-store'
import { attachTaskStatusTransition } from './tasks/task-status-transition'
import { attachWorkerDispatchAbandon } from './worker-dispatch/worker-dispatch-abandon'
import { attachWorkerDispatchAuthority } from './worker-dispatch/worker-dispatch-authority'
import { attachWorkerDispatchOutcome } from './worker-dispatch/worker-dispatch-outcome'
import { attachWorkerDispatchStage } from './worker-dispatch/worker-dispatch-stage'
import { attachWorkerDispatchStart } from './worker-dispatch/worker-dispatch-start'
import { attachWorkerDispatchStop } from './worker-dispatch/worker-dispatch-stop'
import { attachWorkerTerminalRecovery } from './worker-dispatch/worker-terminal-recovery'
import { attachWorkerTerminalArchive } from './worker-terminal/worker-terminal-archive'
import { attachWorkerTerminalAutoRelease } from './worker-terminal/worker-terminal-auto-release'
import { attachWorkerTerminalListing } from './worker-terminal/worker-terminal-listing'
import { attachWorkerTerminalRelease } from './worker-terminal/worker-terminal-release'
import { attachWorkerTerminalResourceStore } from './worker-terminal/worker-terminal-resource-store'
import { attachWorkerTerminalTransfer } from './worker-terminal/worker-terminal-transfer'

export function attachOrchestrationDbMethods(ctor: { prototype: object }): void {
  attachAttemptObservationStore(ctor)
  attachCreateTables(ctor)
  attachSchemaMigrate(ctor)
  attachSchemaColumnProbes(ctor)
  attachMigrateLegacyContractStorage(ctor)
  attachBackfillLegacyQuestionThreads(ctor)
  attachAdoptLegacyRun(ctor)
  attachMutationReceiptStore(ctor)
  attachLifecycleTransition(ctor)
  attachLegacyCompatibilityPrincipals(ctor)
  attachLegacyCompatibilityCandidates(ctor)
  attachLegacyWorkerCompletion(ctor)
  attachLegacyRecoveryCohort(ctor)
  attachLegacyMailAcknowledge(ctor)
  attachLegacyQuestionAcknowledge(ctor)
  attachLegacyLifecycleOperation(ctor)
  attachLegacyAskOperation(ctor)
  attachLegacyQuestionLookup(ctor)
  attachLegacyReplyOperation(ctor)
  attachRunCreate(ctor)
  attachRunBinding(ctor)
  attachRunLookup(ctor)
  attachRunCoordinatorMailRouting(ctor)
  attachLegacyCoordinatorMailTakeover(ctor)
  attachRunDelivery(ctor)
  attachMessageInsert(ctor)
  attachRoleMailboxDelivery(ctor)
  attachStructuredMailSendStore(ctor)
  attachMessageInbox(ctor)
  attachMailboxPointerEnterState(ctor)
  attachDirectMailboxRouting(ctor)
  attachForeignDirectMailboxRouting(ctor)
  attachQuestionThreads(ctor)
  attachTaskStore(ctor)
  attachTaskStatusTransition(ctor)
  attachWorkerDispatchStart(ctor)
  attachWorkerDispatchStage(ctor)
  attachWorkerDispatchAuthority(ctor)
  attachWorkerDispatchOutcome(ctor)
  attachWorkerTerminalRecovery(ctor)
  attachWorkerDispatchStop(ctor)
  attachWorkerDispatchAbandon(ctor)
  attachLegacyRemoteHomeDbMethods(ctor)
  attachLegacyRemoteDbMethods(ctor)
  attachFederationRelayAck(ctor)
  attachPeerMailStore(ctor)
  attachWorkerTerminalResourceStore(ctor)
  attachWorkerTerminalTransfer(ctor)
  attachWorkerTerminalRelease(ctor)
  attachWorkerTerminalArchive(ctor)
  attachWorkerTerminalAutoRelease(ctor)
  attachWorkerTerminalListing(ctor)
  attachDispatchContextStore(ctor)
  attachDispatchLookup(ctor)
  attachDispatchDepth(ctor)
  attachDispatchCompletion(ctor)
  attachWorkerReportSettlement(ctor)
  attachDecisionGateStore(ctor)
  attachCoordinatorRunStore(ctor)
  attachOrchestrationReset(ctor)
  attachCrewMutationNotifications(ctor)
}
