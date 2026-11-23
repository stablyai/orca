// Why: older desktops still offer "Suggest bots for my work"; for one release they get a clear answer
// from a newer server instead of an unknown-method failure.
import { defineMethod } from '../core'

export const BOT_TEMPLATE_METHODS = [
  defineMethod({
    name: 'bots.templates.suggest',
    permission: 'workspace',
    params: null,
    handler: async () => ({
      ok: false as const,
      error: 'Bot suggestions were removed. Update Orca on this computer.'
    })
  })
]
