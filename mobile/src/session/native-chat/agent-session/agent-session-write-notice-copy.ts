import { expiredAttachmentsSentence } from '../../../../../src/shared/agent-session/failures/agent-session-attachment-failure-words'
import { agentSessionFailureSentence } from '../../../../../src/shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentSessionWriteNoticePart,
  AgentSessionWriteNoticeSentence
} from '../../../../../src/shared/agent-session/failures/agent-session-write-notice-copy'
import { joinSentences } from '../../../../../src/shared/text/sentence-joining'
import type { Translate } from '../../../i18n/mobile-i18n'
import { mobileAgentSessionFailureSay } from './agent-session-failure-copy'

function writeNoticeSentences(t: Translate): Record<AgentSessionWriteNoticeSentence, () => string> {
  return {
    notDoneReadHistory: () =>
      t('session.writeNotice.notDoneReadHistory', "This chat's history couldn't be loaded."),
    notDoneSend: () => t('session.writeNotice.notDoneSend', 'Your message was not sent.'),
    tryAgainComposerSend: () => t('session.writeNotice.tryAgainComposerSend', 'Send it again.'),
    messageNotSaved: () => t('session.writeNotice.messageNotSaved', "Couldn't save your message."),
    notDoneStop: () => t('session.writeNotice.notDoneStop', "The agent wasn't stopped."),
    notDoneStopTask: () =>
      t('session.writeNotice.notDoneStopTask', "The background task wasn't stopped."),
    notDoneStopTasks: () =>
      t('session.writeNotice.notDoneStopTasks', "The background tasks weren't stopped."),
    notDoneAnswer: () => t('session.writeNotice.notDoneAnswer', 'Your answer was not sent.'),
    notDoneOption: () => t('session.writeNotice.notDoneOption', "The setting wasn't changed."),
    notDoneCommand: () => t('session.writeNotice.notDoneCommand', "The command didn't run."),
    notDoneGoalChangeIncomplete: () =>
      t(
        'session.writeNotice.notDoneGoalChangeIncomplete',
        "Couldn't finish changing the goal. Check the chat."
      ),
    notDoneQueuedEdit: () => t('session.writeNotice.notDoneQueuedEdit', "Your edit wasn't saved."),
    restartFailed: () => t('session.writeNotice.restartFailed', "The agent couldn't restart."),
    capacity: () =>
      t(
        'session.writeNotice.capacity',
        'Orca on the computer running this chat has hit a request limit. Update Orca there, then try again.'
      ),
    outcomeUnknown: () =>
      t(
        'session.writeNotice.outcomeUnknown',
        "Orca couldn't confirm what happened. Check the chat."
      ),
    sendOutcomeLost: () =>
      t(
        'session.writeNotice.sendOutcomeLost',
        "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
      ),
    continuationSuperseded: () =>
      t(
        'session.writeNotice.continuationSuperseded',
        'This chat has moved on. Check the latest messages before continuing.'
      ),
    questionChanged: () =>
      t(
        'session.writeNotice.questionChanged',
        'This question was already answered or has changed.'
      ),
    cancelNotSaved: () =>
      t('session.writeNotice.cancelNotSaved', "Couldn't cancel this question or approval."),
    historyUnreadable: () =>
      t('session.writeNotice.historyUnreadable', "Orca couldn't read this chat's saved history."),
    historyUnusable: () => t('session.writeNotice.historyUnusable', 'Unable to load this chat.'),
    historyUnavailable: () =>
      t(
        'session.writeNotice.historyUnavailable',
        "Orca couldn't open this chat's history right now."
      ),
    diskFull: () =>
      t('session.writeNotice.diskFull', 'The disk on the computer running this chat is full.'),
    freeDiskSpace: () =>
      t('session.writeNotice.freeDiskSpace', 'Free up space on that disk, then try again.'),
    savedInOtherFolder: () =>
      t('session.writeNotice.savedInOtherFolder', 'This conversation was saved in another folder.'),
    savedByNewerOrca: () =>
      t('session.writeNotice.savedByNewerOrca', 'Chats were saved by a newer Orca.'),
    updateOrcaToKeepUsing: () =>
      t('session.writeNotice.updateOrcaToKeepUsing', 'Update Orca to keep using them.'),
    chatSavedByNewerOrca: () =>
      t('session.writeNotice.chatSavedByNewerOrca', 'This chat was saved by a newer Orca.'),
    updateOrcaToOpenChat: () =>
      t('session.writeNotice.updateOrcaToOpenChat', 'Update Orca to open it.'),
    unsupported: () =>
      t(
        'session.writeNotice.unsupported',
        'This needs a newer Orca on the computer running this chat. Update Orca there, then try again.'
      ),
    notAvailable: () => t('session.writeNotice.notAvailable', "This isn't available in this chat."),
    cannotRunHere: () =>
      t('session.writeNotice.cannotRunHere', "Orca can't run this agent in a chat here."),
    unreachable: () => t('session.writeNotice.unreachable', "Orca couldn't reach the agent."),
    recordFailed: () =>
      t('session.writeNotice.recordFailed', "Orca couldn't save this to the chat's history."),
    attachmentExpired: () => t('session.writeNotice.attachmentExpired', 'This attachment expired.'),
    reattachFile: () => t('session.writeNotice.reattachFile', 'Remove it and attach it again.'),
    reattachFiles: () =>
      t('session.writeNotice.reattachFiles', 'Remove them and attach them again.'),
    conversationCleared: () =>
      t('session.writeNotice.conversationCleared', 'This conversation has been cleared.'),
    openCurrentConversation: () =>
      t(
        'session.writeNotice.openCurrentConversation',
        'Open the current conversation to continue.'
      ),
    clearUnfinished: () =>
      t('session.writeNotice.clearUnfinished', "The last /clear didn't finish."),
    commandRunning: () =>
      t('session.writeNotice.commandRunning', 'A /compact or /clear is still running.'),
    waitForCommand: () =>
      t('session.writeNotice.waitForCommand', 'Wait for the /compact or /clear to finish.'),
    agentStarting: () => t('session.writeNotice.agentStarting', 'The agent is still starting.'),
    waitForStart: () =>
      t('session.writeNotice.waitForStart', 'Wait for the agent to finish starting.'),
    turnActive: () => t('session.writeNotice.turnActive', 'The agent is still responding.'),
    waitForTurn: () =>
      t('session.writeNotice.waitForTurn', 'Wait for the agent to finish responding, or stop it.'),
    promptPending: () =>
      t(
        'session.writeNotice.promptPending',
        'The agent is waiting for an answer to a question or approval.'
      ),
    answerFirst: () =>
      t('session.writeNotice.answerFirst', 'Answer the question or approval first.'),
    backgroundTasksRunning: () =>
      t('session.writeNotice.backgroundTasksRunning', 'Background tasks are still running.'),
    waitForBackgroundTasks: () =>
      t('session.writeNotice.waitForBackgroundTasks', 'Wait for the background tasks to finish.'),
    messagesUnsettled: () =>
      t('session.writeNotice.messagesUnsettled', "A message you sent earlier isn't confirmed yet."),
    settleEarlierMessage: () =>
      t(
        'session.writeNotice.settleEarlierMessage',
        'Wait for your earlier message to go through, or retry it.'
      ),
    agentStillWorking: () =>
      t('session.writeNotice.agentStillWorking', 'The agent is still working.'),
    runClearWhenDone: () => t('session.writeNotice.runClearWhenDone', "Run /clear when it's done."),
    clearAfterAnswer: () =>
      t(
        'session.writeNotice.clearAfterAnswer',
        "Answer the agent's question or approval, then run /clear."
      ),
    runCompactWhenDone: () =>
      t('session.writeNotice.runCompactWhenDone', "Run /compact when it's done."),
    compactAfterAnswer: () =>
      t(
        'session.writeNotice.compactAfterAnswer',
        "Answer the agent's question or approval, then run /compact."
      ),
    clearAfterRetry: () =>
      t('session.writeNotice.clearAfterRetry', 'Retry your earlier message, then run /clear.'),
    compactAfterRetry: () =>
      t('session.writeNotice.compactAfterRetry', 'Retry your earlier message, then run /compact.'),
    clearAfterSending: () =>
      t(
        'session.writeNotice.clearAfterSending',
        'Your earlier message is still being sent. Run /clear once it has gone.'
      ),
    compactAfterSending: () =>
      t(
        'session.writeNotice.compactAfterSending',
        'Your earlier message is still being sent. Run /compact once it has gone.'
      ),
    pendingWork: () =>
      t(
        'session.writeNotice.pendingWork',
        'Wait for pending work and messages to finish before using this command.'
      ),
    queueTooLarge: () =>
      t('session.writeNotice.queueTooLarge', 'Too much text is waiting in the queue.'),
    shrinkQueue: () =>
      t(
        'session.writeNotice.shrinkQueue',
        'Delete a queued message, or wait for one to go through, then try again.'
      ),
    messageTooLarge: () =>
      t('session.writeNotice.messageTooLarge', 'It is over the 256 KB limit for one message.'),
    shortenMessage: () =>
      t('session.writeNotice.shortenMessage', 'Shorten or split it, then send it again.'),
    optionRejected: () =>
      t('session.writeNotice.optionRejected', "The agent didn't accept this setting."),
    goalsUnsupported: () =>
      t('session.writeNotice.goalsUnsupported', "This agent doesn't support goals."),
    agentRefused: () => t('session.writeNotice.agentRefused', 'The agent turned this down.'),
    ownerUnproven: () =>
      t(
        'session.writeNotice.ownerUnproven',
        'The previous agent in this chat may still be running.'
      ),
    reopenChat: () => t('session.writeNotice.reopenChat', 'Reopen the chat to check again.'),
    terminalAgentHoldsChat: () =>
      t(
        'session.writeNotice.terminalAgentHoldsChat',
        'This chat is still open in a terminal agent.'
      ),
    quitTerminalAgent: () =>
      t('session.writeNotice.quitTerminalAgent', 'Quit that agent to continue the chat here.'),
    hostReconciling: () =>
      t(
        'session.writeNotice.hostReconciling',
        'Orca is still checking on this chat after restarting.'
      ),
    waitMoment: () => t('session.writeNotice.waitMoment', 'Wait a moment.'),
    recordUnreadable: () =>
      t('session.writeNotice.recordUnreadable', "Orca couldn't read this chat's saved state."),
    mailOwnerUnconfirmed: () =>
      t(
        'session.writeNotice.mailOwnerUnconfirmed',
        "Orca couldn't confirm this message is still meant for this chat."
      ),
    chatNotFound: () => t('session.writeNotice.chatNotFound', "Orca can't find this chat."),
    startNewChat: () => t('session.writeNotice.startNewChat', 'Start a new chat to continue.'),
    tryAgain: () => t('session.writeNotice.tryAgain', 'Try again.')
  }
}

export function mobileAgentSessionWriteNoticeText(
  parts: readonly AgentSessionWriteNoticePart[],
  t: Translate
): string {
  const sentences = writeNoticeSentences(t)
  const say = mobileAgentSessionFailureSay(t)
  return joinSentences(
    parts.map((part) =>
      typeof part === 'string'
        ? sentences[part]()
        : 'text' in part
          ? part.text
          : 'expiredAttachmentNames' in part
            ? expiredAttachmentsSentence(part.expiredAttachmentNames, say)
            : agentSessionFailureSentence(part.failure, part.surface, part.context, say)
    )
  )
}
