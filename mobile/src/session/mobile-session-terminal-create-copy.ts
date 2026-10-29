import { translate } from '../i18n/mobile-i18n'

export const terminalCreateCopy = {
  forkUnavailable: (agentName: string) =>
    translate(
      'session.useTerminalCreateActions.forkUnavailable',
      'Open the {{agentName}} chat on a connected, updated host and try again.',
      { agentName }
    ),
  forkBusy: (agentName: string) =>
    translate(
      'session.useTerminalCreateActions.forkBusy',
      'Another terminal is opening. Wait, then retry the {{agentName}} chat.',
      { agentName }
    ),
  createFailed: () =>
    translate('session.useTerminalCreateActions.createFailed', 'Failed to create terminal'),
  terminalTitle: () => translate('session.useTerminalCreateActions.terminalTitle', 'Terminal'),
  sendNotesFailed: () =>
    translate('session.useTerminalCreateActions.sendNotesFailed', 'Failed to send notes'),
  inputLocked: () =>
    translate(
      'session.useTerminalCreateActions.inputLocked',
      'Terminal input is locked by another client.'
    ),
  notesSent: () => translate('session.useTerminalCreateActions.notesSent', 'Notes sent'),
  sendNotesError: () =>
    translate('session.useTerminalCreateActions.sendNotesError', "Couldn't send notes")
}
