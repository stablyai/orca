import { z } from 'zod'
import type { PersistedUIState } from '../../../../shared/types'
import { defineMethod, type RpcMethod } from '../core'

const UiUpdate = z.record(z.string(), z.unknown()).default({})

export const CLIENT_UI_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'ui.get',
    params: null,
    handler: (_params, { runtime }) => ({ ui: runtime.getUIState() })
  }),
  defineMethod({
    name: 'ui.set',
    params: UiUpdate,
    handler: (params, { runtime }) => ({
      ui: runtime.updateUIState(params as Partial<PersistedUIState>)
    })
  })
]
