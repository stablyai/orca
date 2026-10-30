import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues
} from '../../../src/shared/agent-session-failure-copy'
import { translate } from '../i18n/mobile-i18n'

export const SEND_FAILURE_COPY = {
  providerExitedRow: (values) =>
    translate(
      'session.failure.providerExitedRow',
      '{{agent}} stopped while this response was in progress. You can continue in this conversation.',
      values
    ),
  providerExitedRejection: (values) =>
    translate(
      'session.failure.providerExitedRejection',
      '{{agent}} stopped before this message was sent.',
      values
    ),
  providerExitedAnswer: (values) =>
    translate(
      'session.failure.providerExitedAnswer',
      '{{agent}} has stopped, so your answer was not sent. Send a message to continue.',
      values
    ),
  claudeEffortInvalid: (values) =>
    translate(
      'session.failure.claudeEffortInvalid',
      'Claude effort is invalid; choose low, medium, high, xhigh, or max and send again.',
      values
    ),
  modelUnavailable: (values) =>
    translate(
      'session.failure.modelUnavailable',
      "{{agent}} couldn't use {{detail}}. Pick another model and send again.",
      values
    ),
  providerRejected: (values) =>
    translate('session.failure.providerRejected', "{{agent}} didn't accept this message.", values),
  providerRejectedQuoted: (values) =>
    translate(
      'session.failure.providerRejectedQuoted',
      "{{agent}} didn't accept this message: {{detail}}.",
      values
    ),
  attachmentEmpty: (values) =>
    translate(
      'session.failure.attachmentEmpty',
      'An image on this message is empty, so the message was not sent.',
      values
    ),
  attachmentTooLarge: (values) =>
    translate(
      'session.failure.attachmentTooLarge',
      'An image on this message is too large, so the message was not sent.',
      values
    ),
  attachmentLargerThan: (values) =>
    translate(
      'session.failure.attachmentLargerThan',
      'An image on this message is larger than {{size}} MB, so the message was not sent.',
      values
    ),
  attachmentTooMany: (values) =>
    translate(
      'session.failure.attachmentTooMany',
      'This message has too many images, so it was not sent.',
      values
    ),
  attachmentAtMost: (values) =>
    translate(
      'session.failure.attachmentAtMost',
      '{{agent}} accepts at most {{limit}} images in one message, so this message was not sent.',
      values
    ),
  attachmentTotalTooLarge: (values) =>
    translate(
      'session.failure.attachmentTotalTooLarge',
      'The images on this message are too large together, so the message was not sent.',
      values
    ),
  attachmentTotalMoreThan: (values) =>
    translate(
      'session.failure.attachmentTotalMoreThan',
      'The images on this message add up to more than {{size}} MB, so the message was not sent.',
      values
    ),
  attachmentUnsupportedType: (values) =>
    translate(
      'session.failure.attachmentUnsupportedType',
      '{{agent}} accepts only PNG, JPEG, GIF, and WebP images, so this message was not sent.',
      values
    ),
  attachmentNotAFile: (values) =>
    translate(
      'session.failure.attachmentNotAFile',
      "An image on this message isn't a file, so the message was not sent.",
      values
    ),
  attachmentNoSource: (values) =>
    translate(
      'session.failure.attachmentNoSource',
      'An image on this message has no file to send, so the message was not sent.',
      values
    ),
  attachmentInvalid: (values) =>
    translate(
      'session.failure.attachmentInvalid',
      "An attachment on this message can't be sent to the agent.",
      values
    ),
  attachmentUnreadable: (values) =>
    translate(
      'session.failure.attachmentUnreadable',
      "An attachment on this message couldn't be read, so the message was not sent.",
      values
    ),
  emptyMessage: (values) =>
    translate('session.failure.emptyMessage', 'This message is empty, so it was not sent.', values),
  commandUnavailable: (values) =>
    translate(
      'session.failure.commandUnavailable',
      "This command isn't available in {{agent}} chats, so it was not sent.",
      values
    ),
  queueFull: (values) =>
    translate(
      'session.failure.queueFull',
      'Too many messages were waiting for the agent, so this one was not sent.',
      values
    ),
  writeFailed: (values) =>
    translate(
      'session.failure.writeFailed',
      "Orca couldn't hand this message to the agent, so it was not sent.",
      values
    ),
  cancelled: (values) =>
    translate(
      'session.failure.cancelled',
      'This message was withdrawn before the agent started it.',
      values
    ),
  chatClosed: (values) =>
    translate(
      'session.failure.chatClosed',
      'The chat closed before this message was sent.',
      values
    ),
  hostRestarted: (values) =>
    translate(
      'session.failure.hostRestarted',
      'Orca restarted before this message was sent.',
      values
    ),
  notDelivered: (values) =>
    translate('session.failure.notDelivered', 'This message was not delivered.', values),
  notDeliveredSendAgain: (values) =>
    translate(
      'session.failure.notDeliveredSendAgain',
      'This message was not delivered. Send it again to continue.',
      values
    ),
  commandRefused: (values) =>
    translate('session.failure.commandRefused', "This command didn't run.", values),
  commandRefusedTryAgain: (values) =>
    translate(
      'session.failure.commandRefusedTryAgain',
      "This command didn't run. Try it again.",
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
