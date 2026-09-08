import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const hostedTasksRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/tasks.tsx', import.meta.url),
  'utf8'
)
const hostOperations = readFileSync(
  new URL('./use-mobile-tasks-host-operations.tsx', import.meta.url),
  'utf8'
)

describe('mobile web Tasks screen binding', () => {
  it('mounts the existing Tasks screen with every hosted operation adapter', () => {
    expect(hostedTasksRoute).toContain(
      "import MobileTasksScreen from '../../../app/h/[hostId]/tasks'"
    )
    expect(hostedTasksRoute).toContain('<MobileTasksScreen')
    expect(hostedTasksRoute).toContain('shell.client.hostRpcSender')
    expect(hostedTasksRoute).toContain('webHostWorkspaceCreationOperations(shell.client)')
    expect(hostedTasksRoute).toContain('nativeHostBinding={false}')
    expect(hostOperations).toContain('nativeHostBinding = true')
    expect(hostOperations).toContain('useHostClient(nativeHostBinding ? hostId : undefined)')
    expect(hostedTasksRoute).not.toMatch(/StyleSheet|className|<View|<Text|<Pressable|<div/)
  })
})
