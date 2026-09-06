import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const hostScreenSource = readFileSync(
  new URL('../host-screen/use-hybrid-host-screen-controller.ts', import.meta.url),
  'utf8'
)
const hostedRouteSource = readFileSync(
  new URL('../../host-web-app/index.tsx', import.meta.url),
  'utf8'
)

describe('mobile web host screen bindings', () => {
  it('keeps the shared presentation behind platform-safe default adapters', () => {
    expect(hostScreenSource).toContain("from '../worktree/default-host-screen-host-state'")
    expect(hostScreenSource).toContain("from '../worktree/default-host-workspace-operations'")
    expect(hostScreenSource).toContain(
      "from '../worktree/default-host-workspace-creation-operations'"
    )
    expect(hostScreenSource).not.toContain("from '../worktree/native-host-screen-host-state'")
    expect(hostScreenSource).not.toContain("from '../worktree/native-host-workspace-operations'")
    expect(hostScreenSource).not.toContain(
      "from '../worktree/native-host-workspace-creation-operations'"
    )
    expect(hostScreenSource).not.toContain("from '../transport/host-removal-lifecycle'")
    expect(hostScreenSource).not.toContain('useForceReconnect')
    expect(hostScreenSource).not.toContain('useCloseHost')
    expect(hostScreenSource).not.toContain('useRouter')
    expect(hostScreenSource).not.toContain('usePathname')
  })

  it('supplies shell-owned host state and bridge operations to the unchanged screen', () => {
    expect(hostedRouteSource).toContain('webHostScreenHostState(')
    expect(hostedRouteSource).toContain('webHostWorkspaceOperations(shell.client)')
    expect(hostedRouteSource).toContain('webHostWorkspaceCreationOperations(shell.client)')
    expect(hostedRouteSource).toContain('hostState={hostState}')
    expect(hostedRouteSource).toContain('workspaceOperations={workspaceOperations}')
    expect(hostedRouteSource).toContain('workspaceCreationOperations={workspaceCreationOperations}')
    expect(hostedRouteSource).toContain('shellOperations={shellOperations}')
    expect(hostedRouteSource).toContain('webHostScreenShellOperations(shell.client')
    expect(hostedRouteSource).toContain('reconnectAttempts: shell.reconnectAttempts')
    expect(hostedRouteSource).toContain('lastConnectedAt: shell.lastConnectedAt')
    expect(hostedRouteSource).toContain('nativeHostBinding={false}')
    expect(hostedRouteSource).toContain('useWebHostStatusGates({')
    expect(hostedRouteSource).toContain('value={hostStatusGates}')
    expect(hostedRouteSource).not.toContain("rememberRoute({ kind: 'workspaceList' })")
    expect(hostedRouteSource).not.toContain('hostCapabilities: []')
    expect(hostedRouteSource).not.toContain('floatingWorkspaceEnabled: false')
    expect(hostedRouteSource).not.toContain('hostDisplayName=')
  })
})
