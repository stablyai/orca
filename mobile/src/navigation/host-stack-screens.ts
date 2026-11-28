import type { Translate } from '../i18n/mobile-i18n'

// Keep native/page stack declarations in sync.
export const HOST_STACK_SCREENS = [
  {
    name: '[hostId]/index',
    title: (t: Translate) => t('navigation.hostStackScreens.host', 'Host')
  },
  {
    name: '[hostId]/edit',
    title: (t: Translate) => t('navigation.hostStackScreens.editComputer', 'Edit computer')
  },
  {
    name: '[hostId]/accounts',
    title: (t: Translate) => t('navigation.hostStackScreens.accounts', 'Accounts')
  },
  {
    name: '[hostId]/resources',
    title: (t: Translate) => t('navigation.hostStackScreens.resources', 'Resources')
  },
  {
    name: '[hostId]/mcp',
    title: (t: Translate) => t('navigation.hostStackScreens.mcpServers', 'MCP servers')
  },
  {
    name: '[hostId]/tasks',
    title: (t: Translate) => t('navigation.hostStackScreens.tasks', 'Tasks')
  },
  {
    name: '[hostId]/automations',
    title: (t: Translate) => t('navigation.hostStackScreens.automations', 'Automations')
  },
  {
    name: '[hostId]/session/[worktreeId]',
    title: (t: Translate) => t('navigation.hostStackScreens.terminal', 'Terminal')
  },
  {
    name: '[hostId]/source-control/[worktreeId]',
    title: (t: Translate) => t('navigation.hostStackScreens.sourceControl', 'Source Control')
  },
  {
    name: '[hostId]/agent-history/[worktreeId]',
    title: (t: Translate) => t('navigation.hostStackScreens.agentSessionHistory', 'Agent history')
  },
  {
    name: '[hostId]/review/[worktreeId]',
    title: (t: Translate) => t('navigation.hostStackScreens.changes', 'Changes')
  },
  {
    name: '[hostId]/pr/[worktreeId]',
    title: (t: Translate) => t('navigation.hostStackScreens.pullRequest', 'Pull Request')
  },
  // Declare catch-all last for its title; named children must match first. Undeclared routes would render with group options anyway.
  {
    name: '[hostId]/[...page]',
    title: (t: Translate) => t('navigation.hostStackScreens.workspace', 'Workspace')
  }
] as const

export type HostStackAnimation = 'none' | 'default'
