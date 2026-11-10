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
        // One folder per mount: its creates' late answers can't reach another folder's screen.
        key={`${props.hostId}\0${props.worktreeId}`}
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
