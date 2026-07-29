// Broadcasts a sanitized task projection to every renderer window, mirroring
// the fan-out pattern used by ipc/keybindings.ts's broadcastKeybindingsChanged.
// Kept separate from audited-task-service.ts so that module stays free of an
// Electron import (easing unit testing with an in-memory repository).
import { BrowserWindow } from 'electron'
import type { AuditedTaskStatusProjection } from '../../shared/audited-workflow-types'

export function broadcastAuditedTaskChanged(projection: AuditedTaskStatusProjection): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('auditedWorkflow:taskChanged', projection)
    }
  }
}
