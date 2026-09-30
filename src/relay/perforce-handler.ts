import { isAbsolute } from 'node:path'
import type { RelayDispatcher } from './dispatcher'
import { expandTilde } from './context'
import { runWithPerforceSettings } from '../shared/perforce/p4-settings-context'
import { normalizePerforceSettings } from '../shared/perforce/perforce-settings'
import { localPerforceBackend } from '../shared/perforce/perforce-backend'
import {
  requireChangelistId,
  requireChangelistTarget,
  requireDepotPaths,
  requireDescription,
  requireDiscardEntries,
  requireRelativePath,
  requireRelativePaths
} from '../shared/perforce/perforce-arguments'

type Params = Record<string, unknown>

function requireCwd(params: Params): string {
  const raw = params.cwd
  if (typeof raw !== 'string' || raw.includes('\0')) {
    throw new Error('Invalid Perforce workspace path')
  }
  const cwd = expandTilde(raw)
  if (!isAbsolute(cwd)) {
    throw new Error('Perforce workspace path must be absolute')
  }
  return cwd
}

/** Runs the same Perforce operations as the desktop app, on the host that owns the workspace. */
export class PerforceHandler {
  constructor(dispatcher: Pick<RelayDispatcher, 'onRequest'>) {
    const backend = localPerforceBackend
    const on = (method: string, run: (cwd: string, params: Params) => Promise<unknown>): void => {
      dispatcher.onRequest(`perforce.${method}`, async (params) =>
        // Why: an older desktop sends no settings; defaults keep it working.
        runWithPerforceSettings(normalizePerforceSettings(params.settings), () =>
          run(requireCwd(params), params)
        )
      )
    }
    on('detect', (cwd) => backend.detect(cwd))
    on('status', (cwd) => backend.status(cwd))
    on('history', (cwd, p) =>
      backend.history(cwd, typeof p.limit === 'number' ? Math.min(p.limit, 200) : 30)
    )
    on('diff', (cwd, p) => backend.diff(cwd, requireRelativePath(p.filePath)))
    on('open', (cwd, p) => backend.open(cwd, requireRelativePaths(p.filePaths)))
    on('close', (cwd, p) => backend.close(cwd, requireRelativePaths(p.filePaths)))
    on('discard', (cwd, p) => backend.discard(cwd, requireDiscardEntries(p.entries)))
    on('submit', (cwd, p) => {
      const target = requireChangelistTarget(p.changelist)
      const message =
        target === 'default' ? requireDescription(p.message, 'Description') : undefined
      return backend.submit(cwd, target, message)
    })
    on('sync', (cwd) => backend.sync(cwd))
    on('shelve', (cwd, p) => backend.shelve(cwd, requireChangelistId(p.changelist)))
    on('unshelve', (cwd, p) => backend.unshelve(cwd, requireChangelistId(p.changelist)))
    on('unshelveFrom', (cwd, p) =>
      backend.unshelveFrom(
        cwd,
        requireChangelistId(p.sourceChangelist),
        requireChangelistTarget(p.changelist)
      )
    )
    on('shelveAndRevertFiles', (cwd, p) =>
      backend.shelveAndRevertFiles(
        cwd,
        requireChangelistId(p.changelist),
        requireRelativePaths(p.filePaths)
      )
    )
    on('unshelveFiles', (cwd, p) =>
      backend.unshelveFiles(cwd, requireChangelistId(p.changelist), requireDepotPaths(p.depotPaths))
    )
    on('deleteChangelistWithFiles', (cwd, p) =>
      backend.deleteChangelistWithFiles(cwd, requireChangelistId(p.changelist))
    )
    on('deleteShelf', (cwd, p) => backend.deleteShelf(cwd, requireChangelistId(p.changelist)))
    on('createChangelist', (cwd, p) =>
      backend.createChangelist(
        cwd,
        requireDescription(p.description, 'Description'),
        Array.isArray(p.filePaths) && p.filePaths.length > 0
          ? requireRelativePaths(p.filePaths)
          : []
      )
    )
    on('editDescription', (cwd, p) =>
      backend.editDescription(
        cwd,
        requireChangelistId(p.changelist),
        requireDescription(p.description, 'Description')
      )
    )
    on('moveToChangelist', (cwd, p) =>
      backend.moveToChangelist(
        cwd,
        requireRelativePaths(p.filePaths),
        requireChangelistTarget(p.changelist)
      )
    )
    on('deleteChangelist', (cwd, p) =>
      backend.deleteChangelist(cwd, requireChangelistId(p.changelist))
    )
    on('diffText', (cwd, p) => backend.diffText(cwd, requireRelativePaths(p.filePaths)))
    on('info', (cwd) => backend.info(cwd))
    on('isReadOnlyFile', (cwd, p) => backend.isReadOnlyFile(cwd, requireRelativePath(p.filePath)))
    on('checkoutIfReadOnly', (cwd, p) =>
      backend.checkoutIfReadOnly(cwd, requireRelativePath(p.filePath))
    )
  }
}
