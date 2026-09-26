import { describe, expect, it, vi } from 'vitest'
import { enrichPort, normalizeWorkspacePortProbes } from './local-workspace-port-attribution'

const workspace = { id: 'workspace', repoId: 'repo', displayName: 'app', path: '/workspace' }

describe('port process labels', () => {
  it.each([
    ['node', 'web-app', 'web-app'],
    ['node', 'api-server', 'api-server'],
    ['node', 'docs', 'docs'],
    ['node', 'Electron', 'node'],
    ['Electron', 'web-app', 'Electron'],
    ['node', 'worker.v2_1', 'worker.v2_1'],
    ['node', 'x'.repeat(64), 'x'.repeat(64)],
    ['node', 'x'.repeat(65), 'node'],
    ['node', undefined, 'node'],
    ['node', '', 'node'],
    ['node', 'node server.js --token=example', 'node'],
    ['node', '/usr/local/bin/node', 'node'],
    ['node', 'C:\\node\\node.exe', 'node'],
    ['node', '--inspect', 'node'],
    ['node', 'TOKEN=example', 'node'],
    ['node', 'web-app\n', 'node'],
    ['node', 'web-app\t', 'node'],
    ['node', 'web-app\u0000', 'node'],
    ['node', 'web-app service', 'node'],
    ['node.exe', 'web-app', 'node.exe'],
    ['web-api', 'different-title', 'web-api'],
    [undefined, 'web-app', undefined]
  ])('labels %s with command %j as %s', (processName, commandLine, expected) => {
    const raw = {
      host: '127.0.0.1',
      port: 3000,
      pid: 123,
      cwd: workspace.path,
      processName,
      commandLine
    }
    const lookup = vi.fn(() => undefined)
    const result = enrichPort(raw, normalizeWorkspacePortProbes([workspace]), { lookup })

    expect(result).toEqual({
      id: '127.0.0.1:3000:123',
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: 3000,
      pid: 123,
      processName: expected,
      protocol: 'http',
      kind: 'workspace',
      owner: {
        worktreeId: workspace.id,
        repoId: workspace.repoId,
        displayName: workspace.displayName,
        path: workspace.path,
        confidence: 'cwd'
      }
    })
    expect(raw.processName).toBe(processName)
    expect(lookup).toHaveBeenCalledWith(workspace.id, 3000, 123)
  })
})
