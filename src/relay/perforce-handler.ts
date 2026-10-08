import { isAbsolute } from 'node:path'
import type { RelayDispatcher } from './dispatcher'
import { expandTilde } from './context'
import { runWithPerforceSettings } from '../shared/perforce/p4-settings-context'
import { normalizePerforceSettings } from '../shared/perforce/perforce-settings'
import { localPerforceBackend } from '../shared/perforce/perforce-backend'
import {
  PERFORCE_OPERATION_NAMES,
  dispatchPerforceOperation
} from '../shared/perforce/perforce-operations'

type Params = Record<string, unknown>

export function requireCwd(params: Params): string {
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
    for (const name of PERFORCE_OPERATION_NAMES) {
      dispatcher.onRequest(`perforce.${name}`, async (params) =>
        // Why: an older desktop sends no settings; defaults keep it working.
        runWithPerforceSettings(normalizePerforceSettings(params.settings), () =>
          dispatchPerforceOperation(localPerforceBackend, name, requireCwd(params), params)
        )
      )
    }
  }
}
