import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  NoteAppendArgs,
  NoteCreateArgs,
  NoteDeleteArgs,
  NoteLinkArgs,
  NoteListArgs,
  NoteRenameArgs,
  NoteSaveArgs,
  NoteSearchArgs,
  NoteShowArgs,
  NotesPanelStateArgs
} from '../../shared/notes-types'

export function registerNotesHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('notes:list')
  ipcMain.removeHandler('notes:show')
  ipcMain.removeHandler('notes:create')
  ipcMain.removeHandler('notes:save')
  ipcMain.removeHandler('notes:rename')
  ipcMain.removeHandler('notes:delete')
  ipcMain.removeHandler('notes:append')
  ipcMain.removeHandler('notes:search')
  ipcMain.removeHandler('notes:link')
  ipcMain.removeHandler('notes:panelState')

  ipcMain.handle('notes:list', (_event, args: NoteListArgs) => runtime.listProjectNotes(args))
  ipcMain.handle('notes:show', (_event, args: NoteShowArgs) => runtime.showProjectNote(args))
  ipcMain.handle('notes:create', (_event, args: NoteCreateArgs) => runtime.createProjectNote(args))
  ipcMain.handle('notes:save', (_event, args: NoteSaveArgs) => runtime.saveProjectNote(args))
  ipcMain.handle('notes:rename', (_event, args: NoteRenameArgs) => runtime.renameProjectNote(args))
  ipcMain.handle('notes:delete', (_event, args: NoteDeleteArgs) => runtime.deleteProjectNote(args))
  ipcMain.handle('notes:append', (_event, args: NoteAppendArgs) => runtime.appendProjectNote(args))
  ipcMain.handle('notes:search', (_event, args: NoteSearchArgs) => runtime.searchProjectNotes(args))
  ipcMain.handle('notes:link', (_event, args: NoteLinkArgs) => runtime.linkProjectNote(args))
  ipcMain.handle('notes:panelState', (_event, args: NotesPanelStateArgs) =>
    runtime.resolveNotesPanelOpenState(args)
  )
}
