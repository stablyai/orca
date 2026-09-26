/** Shared Linear issue-context flags, kept out of the generic help table. */
export function formatLinearIssueContextFlagHelp(flag: string): string | undefined {
  switch (flag) {
    case 'current':
      return '--current              Use the current Orca worktree linked Linear issue'
    case 'comments':
      return '--comments             Include threaded Linear comments'
    case 'children':
      return '--children             Include recursive child issues'
    case 'depth':
      return '--depth <n>            Child issue depth for --children/--full'
    case 'attachments':
      return '--attachments          Include attachment metadata and URLs'
    case 'relations':
      return '--relations            Include blocking, related, and duplicate links'
    case 'activity':
      return '--activity             Include issue field-change history'
    case 'full':
      return '--full                 Include all supported V1 issue context within caps'
    default:
      return undefined
  }
}
