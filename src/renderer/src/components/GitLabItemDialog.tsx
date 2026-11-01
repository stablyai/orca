import { GITLAB_DIALOG_FORGE } from './gitlab-item-dialog/gitlab-dialog-forge'
import { ForgeItemDialog } from './gitlab-item-dialog/forge-item-dialog'
import type { GitLabItemDialogProps } from './gitlab-item-dialog/gitlab-item-dialog-types'

export default function GitLabItemDialog(props: GitLabItemDialogProps) {
  return <ForgeItemDialog forge={GITLAB_DIALOG_FORGE} {...props} />
}
