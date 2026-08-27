import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { PtySpawnResult } from '../../../providers/types'

export type StablePaneOwner = {
  handle?: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  hasPersistedBinding?: true
  bindingRelayProcessId?: string
  persistedIncarnationId?: string
  runtimeIncarnationId?: string
}

export type StablePaneAdoption =
  | {
      result: PtySpawnResult
      owner: StablePaneOwner
      materialized?: true
    }
  | {
      result: null
      owner: null
      absenceVerdict: PtyLivenessVerdict
    }
