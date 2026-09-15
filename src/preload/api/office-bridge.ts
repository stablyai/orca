import { ipcRenderer } from 'electron'
import {
  OFFICE_CLEAR_MARKS_CHANNEL,
  OFFICE_GOTO_CHANNEL,
  OFFICE_MARKS_CHANNEL,
  OFFICE_OPEN_SNAPSHOT_CHANNEL,
  OFFICE_PROBE_CHANNEL,
  OFFICE_RELEASE_SNAPSHOT_CHANNEL,
  OFFICE_SELECTION_CHANNEL,
  OFFICE_SKILLS_INSTALL_CHANNEL,
  OFFICE_SKILLS_LIST_CHANNEL,
  OFFICE_WATCH_REFRESH_CHANNEL,
  OFFICE_WATCH_START_CHANNEL,
  OFFICE_WATCH_STOP_CHANNEL
} from '../../shared/office-preview-channels'
import type { PreloadApi } from '../api-types'

export const officeApi = {
  probe: (request) => ipcRenderer.invoke(OFFICE_PROBE_CHANNEL, request),
  openSnapshot: (request) => ipcRenderer.invoke(OFFICE_OPEN_SNAPSHOT_CHANNEL, request),
  releaseSnapshot: (grantId) => ipcRenderer.invoke(OFFICE_RELEASE_SNAPSHOT_CHANNEL, grantId),
  watchStart: (request) => ipcRenderer.invoke(OFFICE_WATCH_START_CHANNEL, request),
  watchRefresh: (request) => ipcRenderer.invoke(OFFICE_WATCH_REFRESH_CHANNEL, request),
  watchStop: (request) => ipcRenderer.invoke(OFFICE_WATCH_STOP_CHANNEL, request),
  selection: (request) => ipcRenderer.invoke(OFFICE_SELECTION_CHANNEL, request),
  marks: (request) => ipcRenderer.invoke(OFFICE_MARKS_CHANNEL, request),
  clearMarks: (request) => ipcRenderer.invoke(OFFICE_CLEAR_MARKS_CHANNEL, request),
  goto: (request) => ipcRenderer.invoke(OFFICE_GOTO_CHANNEL, request),
  skillsList: (request) => ipcRenderer.invoke(OFFICE_SKILLS_LIST_CHANNEL, request),
  skillsInstall: (request) => ipcRenderer.invoke(OFFICE_SKILLS_INSTALL_CHANNEL, request)
} satisfies PreloadApi['office']
