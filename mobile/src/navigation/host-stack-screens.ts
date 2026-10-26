// Keep native/page stack declarations in sync.
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
  // Declare catch-all last for its title; named children must match first. Undeclared routes would render with group options anyway.
  { name: '[hostId]/[...page]', title: 'Workspace' }
] as const

export type HostStackAnimation = 'none' | 'default'
