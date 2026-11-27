import { AGENT_SESSION_FAILURE_COPY } from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues
} from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import type { Translate } from '../../../i18n/mobile-i18n'

export function sendFailureCopy(t: Translate) {
  return {
    unconfirmed: (values) =>
      t(
        'session.failure.unconfirmed',
        "Couldn't confirm whether this was sent. It hasn't been resent.",
        values
      ),
    providerExitedRow: (values) =>
      t(
        'session.failure.providerExitedRow',
        '{{agent}} stopped while this response was in progress. You can continue in this conversation.',
        values
      ),
    providerExitedRejection: (values) =>
      t(
        'session.failure.providerExitedRejection',
        '{{agent}} stopped before this message was sent.',
        values
      ),
    providerExitedAnswer: (values) =>
      t(
        'session.failure.providerExitedAnswer',
        '{{agent}} has stopped, so your answer was not sent. Send a message to continue.',
        values
      ),
    claudeEffortInvalid: (values) =>
      t(
        'session.failure.claudeEffortInvalid',
        'Claude effort is invalid; choose low, medium, high, xhigh, or max and send again.',
        values
      ),
    modelUnavailable: (values) =>
      t(
        'session.failure.modelUnavailable',
        "{{agent}} couldn't use {{detail}}. Pick another model and send again.",
        values
      ),
    modelNotSelected: (values) =>
      t(
        'session.failure.modelNotSelected',
        '{{agent}} has no model selected. Check your model selection and {{agent}} sign-in, then send again.',
        values
      ),
    modelUnavailableUpdate: (values) =>
      t(
        'session.failure.modelUnavailableUpdate',
        "{{agent}} couldn't use {{detail}}. Update {{agent}} to {{minimumVersion}} or later to keep it after a restart, or pick another model and send again.",
        values
      ),
    selectedModel: (values) =>
      t('session.failure.selectedModel', AGENT_SESSION_FAILURE_COPY.selectedModel, values),
    providerUnavailable: (values) =>
      t(
        'session.failure.providerUnavailable',
        AGENT_SESSION_FAILURE_COPY.providerUnavailable,
        values
      ),
    providerSafetyStopped: (values) =>
      t(
        'session.failure.providerSafetyStopped',
        AGENT_SESSION_FAILURE_COPY.providerSafetyStopped,
        values
      ),
    providerResponseFailed: (values) =>
      t(
        'session.failure.providerResponseFailed',
        AGENT_SESSION_FAILURE_COPY.providerResponseFailed,
        values
      ),
    providerResponseFailedQuoted: (values) =>
      t(
        'session.failure.providerResponseFailedQuoted',
        AGENT_SESSION_FAILURE_COPY.providerResponseFailedQuoted,
        values
      ),
    providerRejected: (values) =>
      t('session.failure.providerRejected', "{{agent}} didn't accept this message.", values),
    providerRejectedQuoted: (values) =>
      t(
        'session.failure.providerRejectedQuoted',
        "{{agent}} didn't accept this message: {{detail}}.",
        values
      ),
    attachmentEmpty: (values) =>
      t(
        'session.failure.attachmentEmpty',
        'An image on this message is empty, so the message was not sent.',
        values
      ),
    attachmentTooLarge: (values) =>
      t(
        'session.failure.attachmentTooLarge',
        'An image on this message is too large, so the message was not sent.',
        values
      ),
    attachmentLargerThan: (values) =>
      t(
        'session.failure.attachmentLargerThan',
        'An image on this message is larger than {{size}} MB, so the message was not sent.',
        values
      ),
    attachmentTooMany: (values) =>
      t(
        'session.failure.attachmentTooMany',
        'This message has too many images, so it was not sent.',
        values
      ),
    attachmentAtMost: (values) =>
      t(
        'session.failure.attachmentAtMost',
        '{{agent}} accepts at most {{limit}} images in one message, so this message was not sent.',
        values
      ),
    attachmentTotalTooLarge: (values) =>
      t(
        'session.failure.attachmentTotalTooLarge',
        'The images on this message are too large together, so the message was not sent.',
        values
      ),
    attachmentTotalMoreThan: (values) =>
      t(
        'session.failure.attachmentTotalMoreThan',
        'The images on this message add up to more than {{size}} MB, so the message was not sent.',
        values
      ),
    attachmentUnsupportedType: (values) =>
      t(
        'session.failure.attachmentUnsupportedType',
        '{{agent}} accepts only PNG, JPEG, GIF, and WebP images, so this message was not sent.',
        values
      ),
    attachmentNotAFile: (values) =>
      t(
        'session.failure.attachmentNotAFile',
        "An image on this message isn't a file, so the message was not sent.",
        values
      ),
    attachmentNoSource: (values) =>
      t(
        'session.failure.attachmentNoSource',
        'An image on this message has no file to send, so the message was not sent.',
        values
      ),
    attachmentInvalid: (values) =>
      t(
        'session.failure.attachmentInvalid',
        "An attachment on this message can't be sent to the agent.",
        values
      ),
    attachmentsExpired: (values) =>
      t('session.failure.attachmentsExpired', '{{names}} expired.', values),
    attachmentUnreadable: (values) =>
      t(
        'session.failure.attachmentUnreadable',
        "An attachment on this message couldn't be read, so the message was not sent.",
        values
      ),
    emptyMessage: (values) =>
      t('session.failure.emptyMessage', 'This message is empty, so it was not sent.', values),
    commandUnavailable: (values) =>
      t(
        'session.failure.commandUnavailable',
        "This command isn't available in {{agent}} chats, so it was not sent.",
        values
      ),
    queueFull: (values) =>
      t(
        'session.failure.queueFull',
        'Too many messages were waiting for the agent, so this one was not sent.',
        values
      ),
    writeFailed: (values) =>
      t(
        'session.failure.writeFailed',
        "Orca couldn't hand this message to the agent, so it was not sent.",
        values
      ),
    cancelled: (values) =>
      t(
        'session.failure.cancelled',
        'This message was withdrawn before the agent started it.',
        values
      ),
    chatClosed: (values) =>
      t('session.failure.chatClosed', 'The chat closed before this message was sent.', values),
    hostRestarted: (values) =>
      t('session.failure.hostRestarted', 'Orca restarted before this message was sent.', values),
    notDelivered: (values) =>
      t('session.failure.notDelivered', 'This message was not delivered.', values),
    notDeliveredSendAgain: (values) =>
      t(
        'session.failure.notDeliveredSendAgain',
        'This message was not delivered. Send it again to continue.',
        values
      ),
    commandRefused: (values) =>
      t('session.failure.commandRefused', "This command didn't run.", values),
    commandRefusedTryAgain: (values) =>
      t('session.failure.commandRefusedTryAgain', "This command didn't run. Try it again.", values)
  } satisfies Partial<
    Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
  >
}
