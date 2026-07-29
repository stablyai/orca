// Runtime capability the desktop advertises when it supports the mobile Tasks RPC
// surface (github/gitlab/linear work items + repo.searchRefs). Older paired
// desktops omit it, so mobile must degrade to blank/new-branch sources only.
// Mirrors the 'mobile.tasks.v1' entry in src/shared/protocol-version.ts.
export const MOBILE_TASKS_CAPABILITY = 'mobile.tasks.v1'
