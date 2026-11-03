# Workspace Cards

Three workspace cards for Orca's left sidebar:

- **Minimal**: one line per workspace with its status, name and review result.
- **Agent first**: agents lead, then the branch (optional) and the review.
- **Review first**: the pull request leads, with its checks and conflicts.

Right-click a workspace and choose **Customize** to pick one. Each card is a JSON template in
`cards/`; copy one into your own plugin to change it.
