import { describe, expect, it } from 'vitest'

import { ACCOUNT_COMMAND_SPECS } from './account'
import { suggestCommands, unknownCommandData } from '../command-suggestion'

describe('account command specs', () => {
  it.each(['move', 'go'])(
    'suggestion safety keeps benign account %s mistakes out of profile deletion',
    (verb) => {
      const path = ['account', verb]
      expect(suggestCommands(ACCOUNT_COMMAND_SPECS, path)).not.toContain('account rm')
      expect(suggestCommands(ACCOUNT_COMMAND_SPECS, path)).not.toContain('account remove')
      const data = unknownCommandData(ACCOUNT_COMMAND_SPECS, path)
      expect(data.nextSteps.join(' ')).not.toContain('orca account rm')
      expect(data.nextSteps.join(' ')).not.toContain('orca account remove')
    }
  )
})
