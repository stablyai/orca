import { describe, expect, it } from 'vitest'
import { parseMacApplicationList } from './macos-open-with-applications'

describe('parseMacApplicationList', () => {
  it('marks the default handler and strips .app from names', () => {
    const output = JSON.stringify({
      defaultPath: '/Applications/TextEdit.app',
      applicationPaths: ['/Applications/TextEdit.app', '/Applications/Visual Studio Code.app']
    })

    expect(parseMacApplicationList(output)).toEqual([
      {
        id: 'macos:/Applications/TextEdit.app',
        name: 'TextEdit',
        isDefault: true,
        launch: { kind: 'macos-application', applicationPath: '/Applications/TextEdit.app' }
      },
      {
        id: 'macos:/Applications/Visual Studio Code.app',
        name: 'Visual Studio Code',
        isDefault: false,
        launch: {
          kind: 'macos-application',
          applicationPath: '/Applications/Visual Studio Code.app'
        }
      }
    ])
  })

  it('includes a default handler missing from the candidate list', () => {
    const output = JSON.stringify({
      defaultPath: '/Applications/Preview.app',
      applicationPaths: []
    })

    const parsed = parseMacApplicationList(output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ name: 'Preview', isDefault: true })
  })

  it('deduplicates repeated application paths', () => {
    const output = JSON.stringify({
      defaultPath: null,
      applicationPaths: ['/Applications/A.app', '/Applications/A.app']
    })
    expect(parseMacApplicationList(output)).toHaveLength(1)
  })
})
