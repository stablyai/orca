import { describe, expect, it } from 'vitest'
import { formatCommandHelp } from '../help'
import { ignoresRemoteSelection } from '../remote-selection-scope'
import { COMMAND_SPECS } from './index'

const REMOTE_SELECTORS = ['environment', 'pairing-code']

function optionFlags(help: string): string[] {
  const options = help.split('\n\nOptions:\n')[1]?.split('\n\n')[0] ?? ''
  return options.split('\n').map((line) => line.trim().split(/\s/)[0] ?? '')
}

describe('remote selectors in command help', () => {
  // Dispatch ignores remote selection for these commands, so help may name a selector only as the command's own argument.
  it.each(COMMAND_SPECS.filter((spec) => ignoresRemoteSelection(spec.path)))(
    'offers no remote selector it ignores for $path',
    (spec) => {
      const offered = optionFlags(formatCommandHelp(spec))
      for (const flag of REMOTE_SELECTORS) {
        if (!spec.usage.includes(`--${flag} `)) {
          expect(offered).not.toContain(`--${flag}`)
        }
      }
    }
  )

  it('keeps a selector the command takes as its own argument', () => {
    const show = COMMAND_SPECS.find((spec) => spec.path.join(' ') === 'environment show')
    expect(optionFlags(show ? formatCommandHelp(show) : '')).toContain('--environment')
  })
})
