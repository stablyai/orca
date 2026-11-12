import type { MessageBoxOptions } from 'electron'
import { translateMain } from '../i18n/main-i18n'

export function movePromptOptions(): MessageBoxOptions {
  return {
    type: 'question',
    buttons: [
      translateMain('applicationsFolderMove.prompt.moveButton', 'Move and Relaunch'),
      translateMain('applicationsFolderMove.prompt.notNowButton', 'Not Now'),
      translateMain('applicationsFolderMove.prompt.neverButton', 'Don’t Ask Again')
    ],
    // Shown right after launch while the user may be typing; Return must not quit and move the app.
    defaultId: 1,
    cancelId: 1,
    title: translateMain('applicationsFolderMove.prompt.title', 'Move Orca to Applications?'),
    message: translateMain(
      'applicationsFolderMove.prompt.message',
      'Move Orca to your Applications folder?'
    ),
    detail: translateMain(
      'applicationsFolderMove.prompt.detail',
      'Orca is running from outside Applications, such as a disk image or Downloads. From there it may not be able to update, and ejecting a disk image while Orca is open can crash it. Orca will move itself into Applications, then quit and reopen. Your settings and sessions are kept.'
    )
  }
}

export function replaceExistingCopyOptions(): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: [
      translateMain('applicationsFolderMove.replace.replaceButton', 'Replace'),
      translateMain('applicationsFolderMove.replace.cancelButton', 'Cancel')
    ],
    // Replacing trashes the other copy, so Return keeps it.
    defaultId: 1,
    cancelId: 1,
    title: translateMain('applicationsFolderMove.replace.title', 'Replace Orca in Applications?'),
    message: translateMain(
      'applicationsFolderMove.replace.message',
      'Another copy of Orca is already in Applications.'
    ),
    detail: translateMain(
      'applicationsFolderMove.replace.detail',
      'Replacing it moves that copy to the Trash.'
    )
  }
}

export function runningCopyOptions(): MessageBoxOptions {
  return {
    type: 'info',
    buttons: [translateMain('applicationsFolderMove.okButton', 'OK')],
    title: translateMain('applicationsFolderMove.running.title', 'Another Orca Is Open'),
    message: translateMain(
      'applicationsFolderMove.running.message',
      'The copy of Orca in Applications is already open.'
    ),
    detail: translateMain(
      'applicationsFolderMove.running.detail',
      'Quit that copy, then reopen this one to move it.'
    )
  }
}

export function moveFailedOptions(): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: [translateMain('applicationsFolderMove.okButton', 'OK')],
    title: translateMain('applicationsFolderMove.failed.title', 'Couldn’t Move Orca'),
    message: translateMain(
      'applicationsFolderMove.failed.message',
      'Orca couldn’t be moved to Applications.'
    ),
    detail: translateMain(
      'applicationsFolderMove.failed.detail',
      'Drag Orca into the Applications folder in Finder instead. This copy keeps running.'
    )
  }
}

export function cannotReplaceCopyOptions(): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: [translateMain('applicationsFolderMove.okButton', 'OK')],
    title: translateMain(
      'applicationsFolderMove.cannotReplace.title',
      'Can’t Replace Orca in Applications'
    ),
    message: translateMain(
      'applicationsFolderMove.cannotReplace.message',
      'Another copy of Orca is already in Applications, and this account can’t replace it.'
    ),
    detail: translateMain(
      'applicationsFolderMove.cannotReplace.detail',
      'Remove or replace that copy in Finder, then reopen this one to move it. This copy keeps running.'
    )
  }
}
