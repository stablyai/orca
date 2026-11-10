import { translate } from '../i18n/mobile-i18n'

// Keep native/page stack declarations in sync.
export const HOST_STACK_SCREENS = [
  {
    name: '[hostId]/index',
    get title() {
      return translate('navigation.hostStackScreens.host', 'Host')
    }
  },
  {
    name: '[hostId]/edit',
    get title() {
      return translate('navigation.hostStackScreens.editHost', 'Edit host')
    }
  },
  {
    name: '[hostId]/accounts',
    get title() {
      return translate('navigation.hostStackScreens.accounts', 'Accounts')
    }
  },
  {
    name: '[hostId]/tasks',
    get title() {
      return translate('navigation.hostStackScreens.tasks', 'Tasks')
    }
  },
  {
    name: '[hostId]/automations',
    get title() {
      return translate('navigation.hostStackScreens.automations', 'Automations')
    }
  },
  {
    name: '[hostId]/session/[worktreeId]',
    get title() {
      return translate('navigation.hostStackScreens.terminal', 'Terminal')
    }
  },
  {
    name: '[hostId]/source-control/[worktreeId]',
    get title() {
      return translate('navigation.hostStackScreens.sourceControl', 'Source Control')
    }
  },
  {
    name: '[hostId]/agent-history/[worktreeId]',
    get title() {
      return translate('navigation.hostStackScreens.agentSessionHistory', 'Agent Session History')
    }
  },
  {
    name: '[hostId]/review/[worktreeId]',
    get title() {
      return translate('navigation.hostStackScreens.changes', 'Changes')
    }
  },
  {
    name: '[hostId]/pr/[worktreeId]',
    get title() {
      return translate('navigation.hostStackScreens.pullRequest', 'Pull Request')
    }
  },
  // Declare catch-all last for its title; named children must match first. Undeclared routes would render with group options anyway.
  {
    name: '[hostId]/[...page]',
    get title() {
      return translate('navigation.hostStackScreens.workspace', 'Workspace')
    }
  }
] as const

export type HostStackAnimation = 'none' | 'default'
