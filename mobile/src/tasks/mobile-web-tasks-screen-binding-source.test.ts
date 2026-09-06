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
    expect(hostedTasksRoute).toContain('webHostTaskReadOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskListOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskDetailOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskItemMutationOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskItemReviewOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskItemFileOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskLinearOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskProviderWriteOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskProjectReadOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskProjectMutationOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostTaskProjectFileOperations(shell.client)')
    expect(hostedTasksRoute).toContain('webHostWorkspaceCreationOperations(shell.client)')
    expect(hostedTasksRoute).toContain('nativeHostBinding={false}')
    expect(hostOperations).toContain('nativeHostBinding = true')
    expect(hostOperations).toContain('useHostClient(nativeHostBinding ? hostId : undefined)')
    expect(hostedTasksRoute).not.toMatch(/StyleSheet|className|<View|<Text|<Pressable|<div/)
  })
})
