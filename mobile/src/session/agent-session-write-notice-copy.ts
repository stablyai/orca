import { agentSessionFailureSentence } from '../../../src/shared/agent-session-failure-words'
import type {
  AgentSessionWriteNoticePart,
  AgentSessionWriteNoticeSentence
} from '../../../src/shared/agent-session-write-notice-copy'
import { translate } from '../i18n/mobile-i18n'
import { sayMobileAgentSessionFailure } from './agent-session-failure-copy'

const SENTENCES: Record<AgentSessionWriteNoticeSentence, () => string> = {
  notDoneReadHistory: () =>
    translate('session.writeNotice.notDoneReadHistory', "This chat's history couldn't be loaded."),
  notDoneSend: () => translate('session.writeNotice.notDoneSend', 'Your message was not sent.'),
  tryAgainComposerSend: () =>
    translate('session.writeNotice.tryAgainComposerSend', 'Send it again.'),
  messageNotSaved: () =>
    translate('session.writeNotice.messageNotSaved', "Couldn't save your message."),
  notDoneStop: () => translate('session.writeNotice.notDoneStop', "The agent wasn't stopped."),
  notDoneStopTask: () =>
    translate('session.writeNotice.notDoneStopTask', "The background task wasn't stopped."),
  notDoneStopTasks: () =>
    translate('session.writeNotice.notDoneStopTasks', "The background tasks weren't stopped."),
  notDoneAnswer: () => translate('session.writeNotice.notDoneAnswer', 'Your answer was not sent.'),
  notDoneOption: () =>
    translate('session.writeNotice.notDoneOption', "The setting wasn't changed."),
  notDoneCommand: () => translate('session.writeNotice.notDoneCommand', "The command didn't run."),
  notDoneGoalChangeIncomplete: () =>
    translate(
      'session.writeNotice.notDoneGoalChangeIncomplete',
      "Couldn't finish changing the goal. Check the chat."
    ),
  notDoneQueuedEdit: () =>
    translate('session.writeNotice.notDoneQueuedEdit', "Your edit wasn't saved."),
  restartFailed: () =>
    translate('session.writeNotice.restartFailed', "The agent couldn't restart."),
  capacity: () =>
    translate(
      'session.writeNotice.capacity',
      'Orca on the computer running this chat has hit a request limit. Update Orca there, then try again.'
    ),
  outcomeUnknown: () =>
    translate(
      'session.writeNotice.outcomeUnknown',
      "Orca couldn't confirm what happened. Check the chat."
    ),
  sendOutcomeLost: () =>
    translate(
      'session.writeNotice.sendOutcomeLost',
      "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
    ),
  continuationSuperseded: () =>
    translate(
      'session.writeNotice.continuationSuperseded',
      'This chat has moved on. Check the latest messages before continuing.'
    ),
  questionChanged: () =>
    translate(
      'session.writeNotice.questionChanged',
      'This question was already answered or has changed.'
    ),
  cancelNotSaved: () =>
    translate('session.writeNotice.cancelNotSaved', "Couldn't cancel this question or approval."),
  historyUnreadable: () =>
    translate(
      'session.writeNotice.historyUnreadable',
      "Orca couldn't read this chat's saved history."
    ),
  historyUnusable: () =>
    translate('session.writeNotice.historyUnusable', 'Unable to load this chat.'),
  historyUnavailable: () =>
    translate(
      'session.writeNotice.historyUnavailable',
      "Orca couldn't open this chat's history right now."
    ),
  savedByNewerOrca: () =>
    translate('session.writeNotice.savedByNewerOrca', 'Chats were saved by a newer Orca.'),
  updateOrcaToKeepUsing: () =>
    translate('session.writeNotice.updateOrcaToKeepUsing', 'Update Orca to keep using them.'),
  chatSavedByNewerOrca: () =>
    translate('session.writeNotice.chatSavedByNewerOrca', 'This chat was saved by a newer Orca.'),
  updateOrcaToOpenChat: () =>
    translate('session.writeNotice.updateOrcaToOpenChat', 'Update Orca to open it.'),
  unsupported: () =>
    translate(
      'session.writeNotice.unsupported',
      'This needs a newer Orca on the computer running this chat. Update Orca there, then try again.'
    ),
  notAvailable: () =>
    translate('session.writeNotice.notAvailable', "This isn't available in this chat."),
  cannotRunHere: () =>
    translate('session.writeNotice.cannotRunHere', "Orca can't run this agent in a chat here."),
  unreachable: () => translate('session.writeNotice.unreachable', "Orca couldn't reach the agent."),
  recordFailed: () =>
    translate('session.writeNotice.recordFailed', "Orca couldn't save this to the chat's history."),
  attachmentExpired: () =>
    translate('session.writeNotice.attachmentExpired', 'This attachment expired.'),
  reattachFile: () =>
    translate('session.writeNotice.reattachFile', 'Remove it and attach it again.'),
  conversationCleared: () =>
    translate('session.writeNotice.conversationCleared', 'This conversation has been cleared.'),
  openCurrentConversation: () =>
    translate(
      'session.writeNotice.openCurrentConversation',
      'Open the current conversation to continue.'
    ),
  clearUnfinished: () =>
    translate('session.writeNotice.clearUnfinished', "The last /clear didn't finish."),
  commandRunning: () =>
    translate('session.writeNotice.commandRunning', 'A /compact or /clear is still running.'),
  waitForCommand: () =>
    translate('session.writeNotice.waitForCommand', 'Wait for the /compact or /clear to finish.'),
  agentStarting: () =>
    translate('session.writeNotice.agentStarting', 'The agent is still starting.'),
  waitForStart: () =>
    translate('session.writeNotice.waitForStart', 'Wait for the agent to finish starting.'),
  turnActive: () => translate('session.writeNotice.turnActive', 'The agent is still responding.'),
  waitForTurn: () =>
    translate(
      'session.writeNotice.waitForTurn',
      'Wait for the agent to finish responding, or stop it.'
    ),
  promptPending: () =>
    translate(
      'session.writeNotice.promptPending',
      'The agent is waiting for an answer to a question or approval.'
    ),
  answerFirst: () =>
    translate('session.writeNotice.answerFirst', 'Answer the question or approval first.'),
  backgroundTasksRunning: () =>
    translate('session.writeNotice.backgroundTasksRunning', 'Background tasks are still running.'),
  waitForBackgroundTasks: () =>
    translate(
      'session.writeNotice.waitForBackgroundTasks',
      'Wait for the background tasks to finish.'
    ),
  messagesUnsettled: () =>
    translate(
      'session.writeNotice.messagesUnsettled',
      "A message you sent earlier isn't confirmed yet."
    ),
  settleEarlierMessage: () =>
    translate(
      'session.writeNotice.settleEarlierMessage',
      'Wait for your earlier message to go through, or retry it.'
    ),
  agentStillWorking: () =>
    translate('session.writeNotice.agentStillWorking', 'The agent is still working.'),
  runClearWhenDone: () =>
    translate('session.writeNotice.runClearWhenDone', "Run /clear when it's done."),
  clearAfterAnswer: () =>
    translate(
      'session.writeNotice.clearAfterAnswer',
      "Answer the agent's question or approval, then run /clear."
    ),
  runCompactWhenDone: () =>
    translate('session.writeNotice.runCompactWhenDone', "Run /compact when it's done."),
  compactAfterAnswer: () =>
    translate(
      'session.writeNotice.compactAfterAnswer',
      "Answer the agent's question or approval, then run /compact."
    ),
  clearAfterRetry: () =>
    translate(
      'session.writeNotice.clearAfterRetry',
      'Retry your earlier message, then run /clear.'
    ),
  compactAfterRetry: () =>
    translate(
      'session.writeNotice.compactAfterRetry',
      'Retry your earlier message, then run /compact.'
    ),
  clearAfterSending: () =>
    translate(
      'session.writeNotice.clearAfterSending',
      'Your earlier message is still being sent. Run /clear once it has gone.'
    ),
  compactAfterSending: () =>
    translate(
      'session.writeNotice.compactAfterSending',
      'Your earlier message is still being sent. Run /compact once it has gone.'
    ),
  pendingWork: () =>
    translate(
      'session.writeNotice.pendingWork',
      'Wait for pending work and messages to finish before using this command.'
    ),
  queueTooLarge: () =>
    translate('session.writeNotice.queueTooLarge', 'Too much text is waiting in the queue.'),
  shrinkQueue: () =>
    translate(
      'session.writeNotice.shrinkQueue',
      'Delete a queued message, or wait for one to go through, then try again.'
    ),
  messageTooLarge: () =>
    translate(
      'session.writeNotice.messageTooLarge',
      'It is over the 256 KB limit for one message.'
    ),
  shortenMessage: () =>
    translate('session.writeNotice.shortenMessage', 'Shorten or split it, then send it again.'),
  optionRejected: () =>
    translate('session.writeNotice.optionRejected', "The agent didn't accept this setting."),
  goalsUnsupported: () =>
    translate('session.writeNotice.goalsUnsupported', "This agent doesn't support goals."),
  agentRefused: () => translate('session.writeNotice.agentRefused', 'The agent turned this down.'),
  ownerUnproven: () =>
    translate(
      'session.writeNotice.ownerUnproven',
      'The previous agent in this chat may still be running.'
    ),
  reopenChat: () => translate('session.writeNotice.reopenChat', 'Reopen the chat to check again.'),
  terminalAgentHoldsChat: () =>
    translate(
      'session.writeNotice.terminalAgentHoldsChat',
      'This chat is still open in a terminal agent.'
    ),
  quitTerminalAgent: () =>
    translate(
      'session.writeNotice.quitTerminalAgent',
      'Quit that agent to continue the chat here.'
    ),
  hostReconciling: () =>
    translate(
      'session.writeNotice.hostReconciling',
      'Orca is still checking on this chat after restarting.'
    ),
  waitMoment: () => translate('session.writeNotice.waitMoment', 'Wait a moment.'),
  recordUnreadable: () =>
    translate(
      'session.writeNotice.recordUnreadable',
      "Orca couldn't read this chat's saved state."
    ),
  chatNotFound: () => translate('session.writeNotice.chatNotFound', "Orca can't find this chat."),
  startNewChat: () =>
    translate('session.writeNotice.startNewChat', 'Start a new chat to continue.'),
  tryAgain: () => translate('session.writeNotice.tryAgain', 'Try again.')
}

export function mobileAgentSessionWriteNoticeText(
  parts: readonly AgentSessionWriteNoticePart[]
): string {
  return parts
    .map((part) =>
      typeof part === 'string'
        ? SENTENCES[part]()
        : 'text' in part
          ? part.text
          : agentSessionFailureSentence(
              part.failure,
              part.surface,
              part.context,
              sayMobileAgentSessionFailure
            )
    )
    .join(' ')
}
