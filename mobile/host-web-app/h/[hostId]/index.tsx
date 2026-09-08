// Why: shared session code leaves to `/h/<hostId>` (leaveSession with no history, the
// missing-worktree bounce). The hosted page lists workspaces at `/`, so without this alias
// those exits landed on expo-router's Unmatched Route screen.
export { default } from '../../index'
