import type { RelayDispatcher } from './dispatcher'
import { runWithPerforceSettings } from '../shared/perforce/p4-settings-context'
import { normalizePerforceSettings } from '../shared/perforce/perforce-settings'
import {
  requireCopyName,
  requireCreateOptions,
  requireRemovalOptions
} from '../shared/perforce/workspace-copy/workspace-copy-arguments'
import { createLocalWorkspaceCopyBackend } from '../shared/perforce/workspace-copy/workspace-copy-backend'
import { createWorkspaceCopyHost } from '../shared/perforce/workspace-copy/workspace-copy-host'
import { requireCwd } from './perforce-handler'

type Params = Record<string, unknown>

/** Perforce workspace copies on the host that owns the workspace (copies need a Windows Dev Drive there). */
export class PerforceCopyHandler {
  constructor(dispatcher: Pick<RelayDispatcher, 'onRequest'>) {
    const backend = createLocalWorkspaceCopyBackend(createWorkspaceCopyHost())
    const on = (method: string, run: (cwd: string, params: Params) => Promise<unknown>): void => {
      dispatcher.onRequest(`perforce.${method}`, async (params) =>
        runWithPerforceSettings(normalizePerforceSettings(params.settings), () =>
          run(requireCwd(params), params)
        )
      )
    }
    on('copyReadiness', (cwd, p) =>
      backend.readiness(cwd, typeof p.minFreeBytes === 'number' ? p.minFreeBytes : undefined)
    )
    on('listCopies', (cwd) => backend.list(cwd))
    on('listCopyStreams', (cwd) => backend.streams(cwd))
    on('createCopy', (cwd, p) => backend.create(cwd, requireCreateOptions(p.options)))
    on('previewCopyRemoval', (cwd, p) => backend.previewRemoval(cwd, requireCopyName(p.name)))
    on('removeCopy', (cwd, p) =>
      backend.remove(cwd, requireCopyName(p.name), requireRemovalOptions(p.options))
    )
  }
}
