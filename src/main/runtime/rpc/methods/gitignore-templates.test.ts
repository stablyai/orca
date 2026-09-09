import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES, GITIGNORE_TEMPLATES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { GITIGNORE_TEMPLATE_METHODS } from './gitignore-templates'

describe('gitignore template runtime contract', () => {
  it('advertises the capability and registers both bounded methods', () => {
    expect(RUNTIME_CAPABILITIES).toContain(GITIGNORE_TEMPLATES_RUNTIME_CAPABILITY)
    expect(GITIGNORE_TEMPLATE_METHODS.map((method) => method.name)).toEqual([
      'gitignoreTemplates.list',
      'gitignoreTemplates.get'
    ])
  })
})
