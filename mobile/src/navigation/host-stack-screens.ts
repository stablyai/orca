/** The screens `app/h/_layout.tsx` declares, shared so the native and page stacks cannot drift. */
export const HOST_STACK_SCREENS = [
  { name: '[hostId]/index', title: 'Host' },
  { name: '[hostId]/edit', title: 'Edit host' },
  { name: '[hostId]/accounts', title: 'Accounts' },
  { name: '[hostId]/tasks', title: 'Tasks' },
  { name: '[hostId]/session/[worktreeId]', title: 'Terminal' },
  { name: '[hostId]/source-control/[worktreeId]', title: 'Source Control' },
  { name: '[hostId]/agent-history/[worktreeId]', title: 'Agent Session History' },
  { name: '[hostId]/review/[worktreeId]', title: 'Changes' },
  { name: '[hostId]/pr/[worktreeId]', title: 'Pull Request' },
  // Dev-flag only: redirects to the host screen unless the hybrid shell flag is on.
  { name: '[hostId]/web', title: 'Workspace' },
  // Last, and matched last: every pathname above has a file of its own, so this takes only what
  // expo-router would otherwise send to Unmatched. Declared for the title alone — an undeclared
  // child still renders, appended after these with this group's screenOptions.
  { name: '[hostId]/[...page]', title: 'Workspace' }
] as const

/** Tablet split view swaps the detail pane instantly; phones slide. */
export type HostStackAnimation = 'none' | 'default'
