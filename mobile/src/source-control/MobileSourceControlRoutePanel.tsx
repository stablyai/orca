import { parseWorkspaceKey } from '../../../src/shared/workspace-scope'
import { MobileFolderSourceControlPanel } from './folder/MobileFolderSourceControlPanel'
import {
  MobileSourceControlPanel,
  type MobileSourceControlPanelProps
} from './MobileSourceControlPanel'

/** Source Control for the workspace a route or dock names: a folder workspace lists its attached worktrees. */
export function MobileSourceControlRoutePanel(props: MobileSourceControlPanelProps) {
  if (parseWorkspaceKey(props.worktreeId)?.type === 'folder') {
    return (
      <MobileFolderSourceControlPanel
        hostId={props.hostId}
        folderWorktreeId={props.worktreeId}
        name={props.name ?? ''}
        embedded={props.embedded ?? false}
        onRequestClose={props.onRequestClose}
      />
    )
  }
  return <MobileSourceControlPanel {...props} />
}
