import type { AttemptObservationStoreMethods } from './attempt-observation-store'
import type { CoordinatorRunStoreMethods } from './coordinator-runs/coordinator-run-store'
import type { DecisionGateStoreMethods } from './decision-gates/decision-gate-store'
import type { DispatchCompletionMethods } from './dispatch-context/dispatch-completion'
import type { DispatchContextStoreMethods } from './dispatch-context/dispatch-context-store'
import type { DispatchLookupMethods } from './dispatch-context/dispatch-lookup'
import type { DispatchDepthMethods } from './dispatch-depth'
import type { WorkerReportSettlementMethods } from './dispatch-context/worker-report-settlement'
import type { FederationRelayAckMethods } from './federation/federation-relay-ack'
import type { LegacyRemoteDbMethods } from '../legacy-remote/legacy-remote-db-methods'
import type { LegacyRemoteHomeDbMethods } from '../legacy-remote-home/legacy-remote-home-db-methods'
import type { PeerMailStoreMethods } from './federation/peer-mail-store'
import type { LegacyAskOperationMethods } from './legacy/legacy-ask-operation'
import type { LegacyCompatibilityCandidatesMethods } from './legacy/legacy-compatibility-candidates'
import type { LegacyCompatibilityPrincipalsMethods } from './legacy/legacy-compatibility-principals'
import type { LegacyLifecycleOperationMethods } from './legacy/legacy-lifecycle-operation'
import type { LegacyMailAcknowledgeMethods } from './legacy/legacy-mail-acknowledge'
import type { LegacyQuestionAcknowledgeMethods } from './legacy/legacy-question-acknowledge'
import type { LegacyQuestionLookupMethods } from './legacy/legacy-question-lookup'
import type { LegacyRecoveryCohortMethods } from './legacy/legacy-recovery-cohort'
import type { LegacyReplyOperationMethods } from './legacy/legacy-reply-operation'
import type { LegacyWorkerCompletionMethods } from './legacy/legacy-worker-completion'
import type { DirectMailboxRoutingMethods } from './messages/direct-mailbox-routing'
import type { ForeignDirectMailboxRoutingMethods } from './messages/foreign-direct-mailbox-routing'
import type { MailboxPointerEnterStateMethods } from './messages/mailbox-pointer-enter-state'
import type { MessageInboxMethods } from './messages/message-inbox'
import type { MessageInsertMethods } from './messages/message-insert'
import type { RoleMailboxDeliveryMethods } from './messages/role-mailbox-delivery'
import type { MutationReceiptStoreMethods } from './mutation-receipts/mutation-receipt-store'
import type { LifecycleTransitionMethods } from './lifecycle-transition'
import type { QuestionThreadsMethods } from './questions/question-threads'
import type { OrchestrationResetMethods } from './reset/orchestration-reset'
import type { RunBindingMethods } from './runs/run-binding'
import type { RunCoordinatorMailRoutingMethods } from './runs/run-coordinator-mail-routing'
import type { RunCreateMethods } from './runs/run-create'
import type { RunDeliveryMethods } from './runs/run-delivery'
import type { RunLookupMethods } from './runs/run-lookup'
import type { LegacyCoordinatorMailTakeoverMethods } from './runs/legacy-coordinator-mail-takeover'
import type { AdoptLegacyRunMethods } from './schema/adopt-legacy-run'
import type { BackfillLegacyQuestionThreadsMethods } from './schema/backfill-legacy-question-threads'
import type { CreateTablesMethods } from './schema/create-tables'
import type { MigrateLegacyContractStorageMethods } from './schema/migrate-legacy-contract-storage'
import type { SchemaMigrateMethods } from './schema/migrate'
import type { SchemaColumnProbesMethods } from './schema/schema-column-probes'
import type { TaskStoreMethods } from './tasks/task-store'
import type { TaskStatusTransitionMethods } from './tasks/task-status-transition'
import type { WorkerDispatchAbandonMethods } from './worker-dispatch/worker-dispatch-abandon'
import type { WorkerDispatchAuthorityMethods } from './worker-dispatch/worker-dispatch-authority'
import type { WorkerDispatchOutcomeMethods } from './worker-dispatch/worker-dispatch-outcome'
import type { WorkerDispatchStageMethods } from './worker-dispatch/worker-dispatch-stage'
import type { WorkerDispatchStartMethods } from './worker-dispatch/worker-dispatch-start'
import type { WorkerDispatchStopMethods } from './worker-dispatch/worker-dispatch-stop'
import type { WorkerTerminalRecoveryMethods } from './worker-dispatch/worker-terminal-recovery'
import type { WorkerTerminalArchiveMethods } from './worker-terminal/worker-terminal-archive'
import type { WorkerTerminalAutoReleaseMethods } from './worker-terminal/worker-terminal-auto-release'
import type { WorkerTerminalListingMethods } from './worker-terminal/worker-terminal-listing'
import type { WorkerTerminalReleaseMethods } from './worker-terminal/worker-terminal-release'
import type { StructuredMailSendStoreMethods } from './messages/structured-mail-send-store'
import type { WorkerTerminalResourceStoreMethods } from './worker-terminal/worker-terminal-resource-store'
import type { WorkerTerminalTransferMethods } from './worker-terminal/worker-terminal-transfer'

export type OrchestrationDbMethods = AttemptObservationStoreMethods &
  CreateTablesMethods &
  SchemaMigrateMethods &
  SchemaColumnProbesMethods &
  MigrateLegacyContractStorageMethods &
  BackfillLegacyQuestionThreadsMethods &
  AdoptLegacyRunMethods &
  MutationReceiptStoreMethods &
  LifecycleTransitionMethods &
  LegacyCompatibilityPrincipalsMethods &
  LegacyCompatibilityCandidatesMethods &
  LegacyWorkerCompletionMethods &
  LegacyRecoveryCohortMethods &
  LegacyMailAcknowledgeMethods &
  LegacyQuestionAcknowledgeMethods &
  LegacyLifecycleOperationMethods &
  LegacyAskOperationMethods &
  LegacyQuestionLookupMethods &
  LegacyReplyOperationMethods &
  RunCreateMethods &
  RunBindingMethods &
  RunLookupMethods &
  RunCoordinatorMailRoutingMethods &
  LegacyCoordinatorMailTakeoverMethods &
  RunDeliveryMethods &
  MessageInsertMethods &
  RoleMailboxDeliveryMethods &
  MessageInboxMethods &
  MailboxPointerEnterStateMethods &
  DirectMailboxRoutingMethods &
  ForeignDirectMailboxRoutingMethods &
  QuestionThreadsMethods &
  TaskStoreMethods &
  TaskStatusTransitionMethods &
  WorkerDispatchStartMethods &
  WorkerDispatchStageMethods &
  WorkerDispatchAuthorityMethods &
  WorkerDispatchOutcomeMethods &
  WorkerTerminalRecoveryMethods &
  WorkerDispatchStopMethods &
  WorkerDispatchAbandonMethods &
  LegacyRemoteHomeDbMethods &
  LegacyRemoteDbMethods &
  FederationRelayAckMethods &
  PeerMailStoreMethods &
  StructuredMailSendStoreMethods &
  WorkerTerminalResourceStoreMethods &
  WorkerTerminalTransferMethods &
  WorkerTerminalReleaseMethods &
  WorkerTerminalArchiveMethods &
  WorkerTerminalAutoReleaseMethods &
  WorkerTerminalListingMethods &
  DispatchContextStoreMethods &
  DispatchLookupMethods &
  DispatchDepthMethods &
  DispatchCompletionMethods &
  WorkerReportSettlementMethods &
  DecisionGateStoreMethods &
  CoordinatorRunStoreMethods &
  OrchestrationResetMethods
