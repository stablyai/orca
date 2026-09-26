import { ipcMain } from 'electron'
import { z } from 'zod'
import { readLinearInbox } from '../linear/linear-inbox'
import { readLinearTriage } from '../linear/linear-triage'

const requestSchema = z.object({
  workspaceId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((value) => value !== 'all'),
  cursor: z.string().uuid().optional()
})

export function registerLinearAttentionHandlers(): void {
  // Personal notification reads are deliberately absent from the runtime RPC catalog.
  ipcMain.handle('linear:personalInbox', (_event, args: unknown) =>
    readLinearInbox(requestSchema.parse(args))
  )
  ipcMain.handle('linear:triagePage', (_event, args: unknown) =>
    readLinearTriage(
      requestSchema.extend({ teamId: z.string().trim().min(1).max(256) }).parse(args)
    )
  )
}
