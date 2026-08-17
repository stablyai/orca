import {
  asRecord,
  optionalFlag,
  optionalLabelFlag,
  requiredString,
  tokenFlags
} from './herdr-stock-cli-flags'

export function workspaceCliArgs(method: string, rawParams: unknown): string[] | null {
  const params = asRecord(rawParams)
  switch (method) {
    case 'workspace.create':
      return [
        'workspace',
        'create',
        ...optionalFlag('--cwd', params.cwd),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'workspace.list':
      return ['workspace', 'list']
    case 'workspace.get':
      return ['workspace', 'get', requiredString(params.workspace_id, 'workspace_id')]
    case 'workspace.focus':
      return ['workspace', 'focus', requiredString(params.workspace_id, 'workspace_id')]
    case 'workspace.rename':
      return [
        'workspace',
        'rename',
        requiredString(params.workspace_id, 'workspace_id'),
        requiredString(params.label, 'label')
      ]
    case 'workspace.report_metadata':
      return [
        'workspace',
        'report-metadata',
        requiredString(params.workspace_id, 'workspace_id'),
        '--source',
        requiredString(params.source, 'source'),
        ...tokenFlags(params.tokens)
      ]
    case 'workspace.close':
      return ['workspace', 'close', requiredString(params.workspace_id, 'workspace_id')]
    case 'worktree.open':
      return [
        'worktree',
        'open',
        ...optionalFlag('--cwd', params.cwd),
        ...optionalFlag('--path', params.path),
        ...optionalFlag('--branch', params.branch),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'worktree.list':
      return ['worktree', 'list', ...optionalFlag('--cwd', params.cwd)]
    case 'worktree.create':
      return [
        'worktree',
        'create',
        ...optionalFlag('--cwd', params.cwd),
        ...optionalFlag('--path', params.path),
        ...optionalFlag('--branch', params.branch),
        ...optionalFlag('--base', params.base),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'worktree.remove':
      return [
        'worktree',
        'remove',
        requiredString(params.workspace_id, 'workspace_id'),
        ...(params.force ? ['--force'] : [])
      ]
    case 'tab.create':
      return [
        'tab',
        'create',
        '--workspace',
        requiredString(params.workspace_id, 'workspace_id'),
        ...optionalFlag('--cwd', params.cwd),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'tab.list':
      return ['tab', 'list', ...optionalFlag('--workspace', params.workspace_id)]
    case 'tab.get':
      return ['tab', 'get', requiredString(params.tab_id, 'tab_id')]
    case 'tab.focus':
      return ['tab', 'focus', requiredString(params.tab_id, 'tab_id')]
    case 'tab.rename':
      return [
        'tab',
        'rename',
        requiredString(params.tab_id, 'tab_id'),
        requiredString(params.label, 'label')
      ]
    case 'tab.move':
      return [
        'tab',
        'move',
        requiredString(params.tab_id, 'tab_id'),
        '--insert-index',
        requiredString(params.insert_index, 'insert_index')
      ]
    case 'tab.close':
      return ['tab', 'close', requiredString(params.tab_id, 'tab_id')]
    default:
      return null
  }
}
