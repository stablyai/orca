import {
  AGENT_SESSION_FAILURE_COPY,
  type AgentSessionFailureCopyValues
} from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import { translate } from '../../../i18n/mobile-i18n'

export const INSTRUCTION_RECOVERY_COPY = {
  instructionNotSent: (values) =>
    translate(
      'session.failure.instructionNotSent',
      AGENT_SESSION_FAILURE_COPY.instructionNotSent,
      values
    ),
  instructionPending: (values) =>
    translate(
      'session.failure.instructionPending',
      AGENT_SESSION_FAILURE_COPY.instructionPending,
      values
    ),
  instructionCommit: (values) =>
    translate(
      'session.failure.instructionCommit',
      AGENT_SESSION_FAILURE_COPY.instructionCommit,
      values
    ),
  instructionUpdate: (values) =>
    translate(
      'session.failure.instructionUpdate',
      AGENT_SESSION_FAILURE_COPY.instructionUpdate,
      values
    ),
  instructionUnknown: (values) =>
    translate(
      'session.failure.instructionUnknown',
      AGENT_SESSION_FAILURE_COPY.instructionUnknown,
      values
    )
} satisfies Partial<
  Record<
    | 'instructionNotSent'
    | 'instructionPending'
    | 'instructionCommit'
    | 'instructionUpdate'
    | 'instructionUnknown',
    (values: AgentSessionFailureCopyValues) => string
  >
>
