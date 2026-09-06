import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const createActionsSource = readFileSync(
  new URL('./use-mobile-tasks-workspace-create-actions.tsx', import.meta.url),
  'utf8'
)

describe('task workspace create name authority', () => {
  // Without this flag the host defaults nameIsAutoManaged to true and drops the typed
  // name, publishing the generated one with displayNameKind 'generated'.
  it('threads the typed-name decision into the create call', () => {
    expect(createActionsSource).toContain(
      'const nameIsAutoManaged =\n          !trimmedWorkspaceName || trimmedWorkspaceName === workspaceLastAutoName'
    )
    expect(createActionsSource).toContain('nameIsAutoManaged,')
  })

  it('keeps the last auto-generated name in scope and in the callback deps', () => {
    const deps = createActionsSource.slice(createActionsSource.lastIndexOf('    ['))
    expect(deps).toContain('workspaceLastAutoName')
  })
})
