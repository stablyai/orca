import { describe, expect, it } from 'vitest'

import { effectiveAllowedFlags } from '../args'
import { formatCommandHelp, formatGroupHelp } from '../help'
import { PROJECT_GROUP_COMMAND_SPECS } from './project-group'

function spec(path: string): (typeof PROJECT_GROUP_COMMAND_SPECS)[number] {
  const found = PROJECT_GROUP_COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!found) {
    throw new Error(`Missing project-group spec: ${path}`)
  }
  return found
}

describe('project-group command specs', () => {
  it('exposes scan and import through group help', () => {
    const help = formatGroupHelp(PROJECT_GROUP_COMMAND_SPECS, 'project-group')

    expect(help).toContain('scan-nested')
    expect(help).toContain('import-nested')
  })

  it('does not accept or advertise browser page targeting', () => {
    for (const entry of PROJECT_GROUP_COMMAND_SPECS) {
      expect(effectiveAllowedFlags(entry)).not.toContain('page')
      expect(formatCommandHelp(entry)).not.toContain('--page')
    }
  })

  it('documents repeated project paths and the two import modes', () => {
    const help = formatCommandHelp(spec('project-group import-nested'))

    expect(help).toContain('--project-path <path>')
    expect(help).toContain('repeat for several')
    expect(help).toContain('Import mode: group or separate')
  })
})
